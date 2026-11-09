import { Prisma, TableTabStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";

/**
 * Fase 2 de `docs/arquitectura/POS_TECHNICAL_DESIGN.md §4.A/§4.B`: apertura,
 * transferencia y cierre FÍSICO de una cuenta de salón sobre una o varias
 * mesas. No incluye todavía ningún invariante económico (saldo, pagos
 * `pending`) — esos bloqueos duros de cierre (§4.B, DECISIÓN APROBADA) se
 * incorporan en la Fase 6, cuando exista el ledger de pagos y `orders`
 * tenga `table_tab_id` (Fase 3). Cerrar una cuenta acá solo libera las
 * mesas; la Fase 6 debe llamar a estas funciones DESPUÉS de validar sus
 * propios bloqueos, nunca reemplazarlas.
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

  return prisma.$transaction(async (tx) => {
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
// Cierre físico — sin invariantes económicos todavía (ver nota de cabecera).
// ---------------------------------------------------------------------------

export type CloseTableTabResult =
  | { ok: true; tableTab: AdminTableTabDto }
  | { ok: false; reason: "TABLE_TAB_NOT_FOUND" | "TABLE_TAB_NOT_OPEN" };

export async function closeTableTab(params: {
  businessId: string;
  tableTabId: string;
}): Promise<CloseTableTabResult> {
  const { businessId, tableTabId } = params;

  return prisma.$transaction(async (tx) => {
    await acquireTabLock(tx, businessId, tableTabId);

    const tab = await tx.table_tab.findFirst({ where: { id: tableTabId, business_id: businessId } });
    if (!tab) {
      return { ok: false, reason: "TABLE_TAB_NOT_FOUND" } as const;
    }
    if (tab.status !== TableTabStatus.open) {
      return { ok: false, reason: "TABLE_TAB_NOT_OPEN" } as const;
    }

    await tx.table_tab_table.updateMany({
      where: { table_tab_id: tableTabId, unassigned_at: null },
      data: { unassigned_at: new Date() }
    });
    await tx.table_tab.update({
      where: { id: tableTabId },
      data: { status: TableTabStatus.closed, closed_at: new Date() }
    });

    const updated = await loadTableTabOrThrow(tx, businessId, tableTabId);
    return { ok: true, tableTab: mapTableTab(updated) } as const;
  });
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
