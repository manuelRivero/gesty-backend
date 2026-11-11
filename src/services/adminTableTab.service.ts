import { Prisma, TableTabStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  getTableTabBalance,
  hasPendingOrPreparingKitchenItems,
  hasPendingTabPayment
} from "./tabPayment.service";
import { createBillableChargeForAllUnbilledItems } from "./billableCharge.service";
import { triggerAutomaticInvoiceEmissionForBillableCharge } from "./invoicing/invoice.service";
import { BillableChargeStatus } from "@prisma/client";
import { emitAdminTableTabClosed, emitAdminTableTabOpened } from "../socket/adminSocket";

/**
 * Fase 2 de `docs/arquitectura/POS_TECHNICAL_DESIGN.md §4.A/§4.B`: apertura,
 * transferencia y cierre de una cuenta de salón sobre una o varias mesas.
 *
 * El cierre (`closeTableTab`) incorpora los tres invariantes económicos
 * aprobados en §4.B ("cierre estricto basado en invariantes contables"):
 * tres bloqueos duros (saldo ≠ 0, pago `pending` abierto, `billable_charge`
 * `open` sin facturar — este último agregado en Fase 7, ya con la tabla
 * existente) más una advertencia blanda (productos sin despachar).
 */

// ---------------------------------------------------------------------------
// Advisory locks — mismo patrón que `acquireOrderCreateLock`
// (`src/services/checkout.service.ts`): clave textual + `pg_advisory_xact_lock`,
// tomado como primera operación dentro de la transacción que relee y escribe.
// ---------------------------------------------------------------------------

const tableLockKey = (businessId: string, tableId: string): string =>
  `table-tab:table:${businessId}:${tableId}`;

const tabLockKey = (businessId: string, tableTabId: string): string =>
  `table-tab:tab:${businessId}:${tableTabId}`;

const acquireTableLock = (
  tx: Prisma.TransactionClient,
  businessId: string,
  tableId: string
): Promise<unknown> =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tableLockKey(businessId, tableId)}))`;

const acquireTabLock = (
  tx: Prisma.TransactionClient,
  businessId: string,
  tableTabId: string
): Promise<unknown> =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tabLockKey(businessId, tableTabId)}))`;

/**
 * Dos locks de mesa en la misma transacción (transferencia, fusión futura)
 * deben tomarse siempre en el mismo orden determinístico (orden lexicográfico
 * de `table_id`), sin importar el orden en que el caller los pidió — evita
 * deadlock entre dos transferencias concurrentes que involucren el mismo par
 * de mesas en sentido inverso.
 */
const acquireTableLocksOrdered = async (
  tx: Prisma.TransactionClient,
  businessId: string,
  tableIds: string[]
): Promise<void> => {
  const ordered = [...new Set(tableIds)].sort();
  for (const tableId of ordered) {
    await acquireTableLock(tx, businessId, tableId);
  }
};

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

const tableTabInclude = {
  tables: {
    where: { unassigned_at: null },
    include: { table: { select: { id: true, name: true, environment_id: true } } }
  },
  // Mozo responsable actual — mostrado en el panel admin ("quién atiende esta
  // mesa") y usado para identificar a quién notificar al cerrar la cuenta.
  // `app_user.id` (no `business_user.id`) porque es lo que el frontend puede
  // comparar directo contra el JWT del mozo logueado (ver `adminSocket.ts`,
  // evento `table_tab.closed`).
  assigned_to: {
    select: { id: true, app_user: { select: { id: true, name: true } } }
  }
} as const;

type TableTabWithTables = Prisma.table_tabGetPayload<{ include: typeof tableTabInclude }>;

function mapTableTab(row: TableTabWithTables) {
  return {
    id: row.id,
    businessId: row.business_id,
    status: row.status,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    openedByUserId: row.opened_by_user_id,
    assignedUserId: row.assigned_user_id,
    assignedUserName: row.assigned_to?.app_user.name ?? null,
    assignedUserAppUserId: row.assigned_to?.app_user.id ?? null,
    tables: row.tables.map((t) => ({
      tableId: t.table_id,
      tableName: t.table.name,
      environmentId: t.table.environment_id,
      assignedAt: t.assigned_at
    }))
  };
}

export type AdminTableTabDto = ReturnType<typeof mapTableTab>;

async function loadTableTabOrThrow(
  tx: Prisma.TransactionClient,
  businessId: string,
  tableTabId: string
) {
  const row = await tx.table_tab.findFirst({
    where: { id: tableTabId, business_id: businessId },
    include: tableTabInclude
  });
  if (!row) {
    throw new Error("TABLE_TAB_NOT_FOUND");
  }
  return row;
}

async function hasActiveAssignment(
  tx: Prisma.TransactionClient,
  tableId: string
): Promise<boolean> {
  const active = await tx.table_tab_table.findFirst({
    where: { table_id: tableId, unassigned_at: null },
    select: { id: true }
  });
  return active !== null;
}

// ---------------------------------------------------------------------------
// Apertura
// ---------------------------------------------------------------------------

export type OpenTableTabResult =
  | { ok: true; tableTab: AdminTableTabDto }
  | { ok: false; reason: "TABLE_NOT_FOUND" | "TABLE_ALREADY_OCCUPIED" };

export async function openTableTab(params: {
  businessId: string;
  tableId: string;
  openedByUserId: string;
}): Promise<OpenTableTabResult> {
  const { businessId, tableId, openedByUserId } = params;

  const result = await prisma.$transaction(async (tx) => {
    await acquireTableLock(tx, businessId, tableId);

    const table = await tx.table.findFirst({
      where: { id: tableId, business_id: businessId }
    });
    if (!table) {
      return { ok: false, reason: "TABLE_NOT_FOUND" } as const;
    }

    // Chequeo de aplicación bajo lock: evita la escritura inútil y da un
    // error de negocio legible. La garantía real contra doble asignación es
    // el índice único parcial (`unique_table_tab_table_active_assignment`),
    // no este chequeo — ver nota en el modelo Prisma `table_tab_table`.
    if (await hasActiveAssignment(tx, tableId)) {
      return { ok: false, reason: "TABLE_ALREADY_OCCUPIED" } as const;
    }

    const created = await tx.table_tab.create({
      data: {
        business_id: businessId,
        status: TableTabStatus.open,
        opened_by_user_id: openedByUserId,
        assigned_user_id: openedByUserId,
        tables: {
          create: { table_id: tableId }
        }
      },
      include: tableTabInclude
    });

    return { ok: true, tableTab: mapTableTab(created) } as const;
  });

  // Post-commit, fire-and-forget: para que ADMIN/OWNER vean en su propio
  // plano que la mesa se ocupó sin tener que refrescar (mismo patrón que
  // `closeTableTab`/`emitAdminTableTabClosed`).
  if (result.ok) {
    emitAdminTableTabOpened(businessId, {
      tableTabId: result.tableTab.id,
      assignedUserAppUserId: result.tableTab.assignedUserAppUserId,
      assignedUserName: result.tableTab.assignedUserName,
      tableIds: result.tableTab.tables.map((t) => t.tableId),
      tableNames: result.tableTab.tables.map((t) => t.tableName)
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Agrupar una mesa adicional a una cuenta ya abierta
// ---------------------------------------------------------------------------

export type AssignTableResult =
  | { ok: true; tableTab: AdminTableTabDto }
  | { ok: false; reason: "TABLE_TAB_NOT_FOUND" | "TABLE_TAB_NOT_OPEN" | "TABLE_NOT_FOUND" | "TABLE_ALREADY_OCCUPIED" };

export async function assignTableToTab(params: {
  businessId: string;
  tableTabId: string;
  tableId: string;
}): Promise<AssignTableResult> {
  const { businessId, tableTabId, tableId } = params;

  return prisma.$transaction(async (tx) => {
    await acquireTableLock(tx, businessId, tableId);

    const tab = await tx.table_tab.findFirst({ where: { id: tableTabId, business_id: businessId } });
    if (!tab) {
      return { ok: false, reason: "TABLE_TAB_NOT_FOUND" } as const;
    }
    if (tab.status !== TableTabStatus.open) {
      return { ok: false, reason: "TABLE_TAB_NOT_OPEN" } as const;
    }

    const table = await tx.table.findFirst({ where: { id: tableId, business_id: businessId } });
    if (!table) {
      return { ok: false, reason: "TABLE_NOT_FOUND" } as const;
    }

    if (await hasActiveAssignment(tx, tableId)) {
      return { ok: false, reason: "TABLE_ALREADY_OCCUPIED" } as const;
    }

    await tx.table_tab_table.create({
      data: { table_tab_id: tableTabId, table_id: tableId }
    });

    const updated = await loadTableTabOrThrow(tx, businessId, tableTabId);
    return { ok: true, tableTab: mapTableTab(updated) } as const;
  });
}

// ---------------------------------------------------------------------------
// Transferencia: cerrar la fila activa vieja, abrir una nueva. Nunca editar
// la fila existente (DECISIÓN APROBADA, §4.A) — preserva trazabilidad de qué
// mesa ocupó la cuenta en cada momento, sin mantener historial versionado
// explotable en reportes (DECISIÓN APROBADA — "mesa actual" para el MVP).
// ---------------------------------------------------------------------------

export type TransferTableResult =
  | { ok: true; tableTab: AdminTableTabDto }
  | {
      ok: false;
      reason:
        | "TABLE_TAB_NOT_FOUND"
        | "TABLE_TAB_NOT_OPEN"
        | "SOURCE_TABLE_NOT_ASSIGNED"
        | "TARGET_TABLE_NOT_FOUND"
        | "TARGET_TABLE_ALREADY_OCCUPIED";
    };

export async function transferTable(params: {
  businessId: string;
  tableTabId: string;
  fromTableId: string;
  toTableId: string;
}): Promise<TransferTableResult> {
  const { businessId, tableTabId, fromTableId, toTableId } = params;

  return prisma.$transaction(async (tx) => {
    await acquireTableLocksOrdered(tx, businessId, [fromTableId, toTableId]);

    const tab = await tx.table_tab.findFirst({ where: { id: tableTabId, business_id: businessId } });
    if (!tab) {
      return { ok: false, reason: "TABLE_TAB_NOT_FOUND" } as const;
    }
    if (tab.status !== TableTabStatus.open) {
      return { ok: false, reason: "TABLE_TAB_NOT_OPEN" } as const;
    }

    const activeSourceAssignment = await tx.table_tab_table.findFirst({
      where: { table_tab_id: tableTabId, table_id: fromTableId, unassigned_at: null }
    });
    if (!activeSourceAssignment) {
      return { ok: false, reason: "SOURCE_TABLE_NOT_ASSIGNED" } as const;
    }

    const targetTable = await tx.table.findFirst({ where: { id: toTableId, business_id: businessId } });
    if (!targetTable) {
      return { ok: false, reason: "TARGET_TABLE_NOT_FOUND" } as const;
    }
    if (await hasActiveAssignment(tx, toTableId)) {
      return { ok: false, reason: "TARGET_TABLE_ALREADY_OCCUPIED" } as const;
    }

    await tx.table_tab_table.update({
      where: { id: activeSourceAssignment.id },
      data: { unassigned_at: new Date() }
    });
    await tx.table_tab_table.create({
      data: { table_tab_id: tableTabId, table_id: toTableId }
    });

    const updated = await loadTableTabOrThrow(tx, businessId, tableTabId);
    return { ok: true, tableTab: mapTableTab(updated) } as const;
  });
}

// ---------------------------------------------------------------------------
// Reasignación de mozo — PATCH simple (DECISIÓN APROBADA, §4.A): ningún
// historial inmutable de reasignación para el MVP, se difiere
// `table_tab_assignment_event`.
// ---------------------------------------------------------------------------

export type ReassignTableTabResult =
  | { ok: true; tableTab: AdminTableTabDto }
  | { ok: false; reason: "TABLE_TAB_NOT_FOUND" | "TABLE_TAB_NOT_OPEN" };

export async function reassignTableTab(params: {
  businessId: string;
  tableTabId: string;
  assignedUserId: string;
}): Promise<ReassignTableTabResult> {
  const { businessId, tableTabId, assignedUserId } = params;

  return prisma.$transaction(async (tx) => {
    await acquireTabLock(tx, businessId, tableTabId);

    const tab = await tx.table_tab.findFirst({ where: { id: tableTabId, business_id: businessId } });
    if (!tab) {
      return { ok: false, reason: "TABLE_TAB_NOT_FOUND" } as const;
    }
    if (tab.status !== TableTabStatus.open) {
      return { ok: false, reason: "TABLE_TAB_NOT_OPEN" } as const;
    }

    await tx.table_tab.update({
      where: { id: tableTabId },
      data: { assigned_user_id: assignedUserId }
    });

    const updated = await loadTableTabOrThrow(tx, businessId, tableTabId);
    return { ok: true, tableTab: mapTableTab(updated) } as const;
  });
}

// ---------------------------------------------------------------------------
// Cierre — invariantes económicos de Fase 6 (§4.B, DECISIÓN APROBADA, ver
// cabecera del archivo).
// ---------------------------------------------------------------------------

export type CloseTableTabResult =
  | { ok: true; tableTab: AdminTableTabDto; hasPendingKitchenItems: boolean }
  | {
      ok: false;
      reason:
        | "TABLE_TAB_NOT_FOUND"
        | "TABLE_TAB_NOT_OPEN"
        | "BALANCE_NOT_ZERO"
        | "PENDING_PAYMENT_EXISTS"
        | "OPEN_BILLABLE_CHARGE_EXISTS";
      /** Solo en `OPEN_BILLABLE_CHARGE_EXISTS` — permite reintentar la emisión fire-and-forget (§4.E). */
      billableChargeId?: string;
    };

export async function closeTableTab(params: {
  businessId: string;
  tableTabId: string;
}): Promise<CloseTableTabResult> {
  const { businessId, tableTabId } = params;

  const result = await prisma.$transaction(async (tx) => {
    await acquireTabLock(tx, businessId, tableTabId);

    const tab = await tx.table_tab.findFirst({ where: { id: tableTabId, business_id: businessId } });
    if (!tab) {
      return { ok: false, reason: "TABLE_TAB_NOT_FOUND" } as const;
    }
    if (tab.status !== TableTabStatus.open) {
      return { ok: false, reason: "TABLE_TAB_NOT_OPEN" } as const;
    }

    // Bloqueos duros — releídos BAJO el lock, nunca sobre un saldo leído
    // antes de adquirirlo (§4.B, "Impacto técnico").
    const balance = await getTableTabBalance(tx, businessId, tableTabId);
    if (!balance.isZero()) {
      return { ok: false, reason: "BALANCE_NOT_ZERO" } as const;
    }
    if (await hasPendingTabPayment(tx, businessId, tableTabId)) {
      return { ok: false, reason: "PENDING_PAYMENT_EXISTS" } as const;
    }
    // Red de seguridad (§4.E): por si el disparo fire-and-forget de
    // `autoBillAndInvoiceTableTab` (post-pago) todavía no corrió para cuando
    // alguien ya intenta cerrar — consolida lo que quede sin facturar ANTES
    // del chequeo de bloqueo duro de abajo, bajo el mismo lock de cuenta.
    await createBillableChargeForAllUnbilledItems(tx, businessId, tableTabId);
    const openCharge = await tx.billable_charge.findFirst({
      where: { business_id: businessId, table_tab_id: tableTabId, status: BillableChargeStatus.open },
      select: { id: true }
    });
    if (openCharge) {
      return { ok: false, reason: "OPEN_BILLABLE_CHARGE_EXISTS", billableChargeId: openCharge.id } as const;
    }

    // Advertencia blanda — informativa, nunca bloquea (§4.B).
    const hasPendingKitchenItems = await hasPendingOrPreparingKitchenItems(
      tx,
      businessId,
      tableTabId
    );

    // Capturado ANTES de cerrar: `mapTableTab` filtra `tables` por
    // `unassigned_at IS NULL`, así que después del `updateMany` de abajo
    // quedaría vacío — necesitamos los nombres para la notificación al mozo.
    const beforeClose = await loadTableTabOrThrow(tx, businessId, tableTabId);
    const beforeCloseTables = mapTableTab(beforeClose).tables;
    const tableIds = beforeCloseTables.map((t) => t.tableId);
    const tableNames = beforeCloseTables.map((t) => t.tableName);

    await tx.table_tab_table.updateMany({
      where: { table_tab_id: tableTabId, unassigned_at: null },
      data: { unassigned_at: new Date() }
    });
    await tx.table_tab.update({
      where: { id: tableTabId },
      data: { status: TableTabStatus.closed, closed_at: new Date() }
    });

    const updated = await loadTableTabOrThrow(tx, businessId, tableTabId);
    const updatedDto = mapTableTab(updated);
    return {
      ok: true,
      tableTab: updatedDto,
      hasPendingKitchenItems,
      assignedUserAppUserId: updatedDto.assignedUserAppUserId,
      tableIds,
      tableNames
    } as const;
  });

  if (result.ok) {
    emitAdminTableTabClosed(businessId, {
      tableTabId,
      assignedUserAppUserId: result.assignedUserAppUserId,
      tableIds: result.tableIds,
      tableNames: result.tableNames
    });
  } else if (result.reason === "OPEN_BILLABLE_CHARGE_EXISTS" && result.billableChargeId) {
    // Fire-and-forget: le da a un segundo intento de cierre inmediato buena
    // chance de encontrar el charge ya `issued` (§4.E).
    void triggerAutomaticInvoiceEmissionForBillableCharge(businessId, result.billableChargeId).catch(
      (err) => {
        console.error("[Invoicing] Error en auto-facturación al intentar cerrar la cuenta:", err);
      }
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Lecturas — para el floor-plan admin ("mesa libre/ocupada", §4.A: derivado,
// nunca un campo propio de `table`).
// ---------------------------------------------------------------------------

export async function getTableTabById(params: {
  businessId: string;
  id: string;
}): Promise<AdminTableTabDto | null> {
  const row = await prisma.table_tab.findFirst({
    where: { id: params.id, business_id: params.businessId },
    include: tableTabInclude
  });
  return row ? mapTableTab(row) : null;
}

export async function listOpenTableTabs(params: {
  businessId: string;
}): Promise<AdminTableTabDto[]> {
  const rows = await prisma.table_tab.findMany({
    where: { business_id: params.businessId, status: TableTabStatus.open },
    include: tableTabInclude,
    orderBy: { opened_at: "asc" }
  });
  return rows.map(mapTableTab);
}

/** `Set` de `table_id` ocupados (con asignación activa a una cuenta abierta) del negocio. */
export async function listOccupiedTableIds(params: { businessId: string }): Promise<Set<string>> {
  const rows = await prisma.table_tab_table.findMany({
    where: {
      unassigned_at: null,
      table_tab: { business_id: params.businessId, status: TableTabStatus.open }
    },
    select: { table_id: true }
  });
  return new Set(rows.map((r) => r.table_id));
}

export type TableTabOrderItemDto = {
  id: string;
  menuItemId: string;
  menuItemName: string;
  quantity: number;
  unitPrice: Prisma.Decimal;
  notes: string | null;
  variation: string | null;
};

export type TableTabOrderDto = {
  orderId: string;
  createdAt: Date;
  status: string;
  totalAmount: Prisma.Decimal | null;
  items: TableTabOrderItemDto[];
};

/**
 * Rondas (`orders`) de una cuenta de salón con sus ítems — "el pedido" que el
 * mozo/encargado necesita ver al clickear una mesa ocupada en `/pos`. Snapshot
 * simple: no reconcilia `order_item_adjustment` (anulaciones) todavía, cada
 * ítem se muestra tal como se confirmó en su ronda.
 */
export async function listTableTabOrders(params: {
  businessId: string;
  tableTabId: string;
}): Promise<TableTabOrderDto[]> {
  const orders = await prisma.orders.findMany({
    where: { business_id: params.businessId, table_tab_id: params.tableTabId },
    orderBy: { created_at: "asc" },
    include: {
      order_item: {
        include: { menu_item: { select: { id: true, name: true } } }
      }
    }
  });

  return orders.map((order) => ({
    orderId: order.id,
    createdAt: order.created_at,
    status: order.status,
    totalAmount: order.total_amount,
    items: order.order_item.map((item) => ({
      id: item.id,
      menuItemId: item.menu_item_id,
      menuItemName: item.menu_item.name,
      quantity: item.quantity,
      unitPrice: item.unit_price,
      notes: item.notes,
      variation: item.variation
    }))
  }));
}
