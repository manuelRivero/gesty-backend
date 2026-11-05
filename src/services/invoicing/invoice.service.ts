import { FiscalInvoiceStatus, FiscalInvoiceKind, Prisma, type fiscal_invoice } from "@prisma/client";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { prisma } from "../../lib/prisma";
import {
  BillingLockTimeoutError,
  BillingLockUnavailableError,
  withBillingLock,
} from "../billing/billingLock";
import {
  BillingProviderRejectionError,
  BillingProviderTechnicalError,
  type CondicionIva,
  type FiscalCustomer,
  type FiscalInvoiceLineItem,
  type FiscalInvoiceResult,
  type IssueInvoiceRequest,
} from "../../domain/invoicing/types";
import type { BillingProvider } from "../../domain/invoicing/billingProvider.port";
import { resolveBillingProvider, resolveCurrentEnvironment } from "./billingProviderFactory";
import { ensureEmisorProvisioned } from "./emisorProvisioning.service";
import { getFiscalConfiguration } from "./fiscalConfiguration.service";
import { withFiscalConfigurationLock } from "./fiscalConfigurationLock";
import { isInvoicingAddonEnabled } from "./invoicingAddon.service";
import { recordProviderRequest, recordVoucherAuthorized } from "./invoicingUsage.service";
import { resolveVoucherTypeForConsumidorFinal } from "./voucherTypeResolver";

dayjs.extend(utc);

export interface InvoiceEmissionOutcome {
  emitted: boolean;
  invoice?: fiscal_invoice;
  reason?: string;
}

/**
 * Namespace de lock dedicado a facturación — independiente de
 * `SUBSCRIPTION_LIFECYCLE_NAMESPACE` (ver `billingLock.ts`). Nunca compartir namespace
 * entre dominios: el hash de la clave de advisory lock se deriva de `namespace:key`.
 */
const INVOICING_EMISSION_NAMESPACE = "gesty:invoicing:emission";

/** Umbral para considerar un `processing` como abandonado (proceso caído a mitad de camino) vs. en curso. */
const PROCESSING_STALE_MS = 2 * 60_000;

/** Tope de reconciliaciones automáticas antes de requerir revisión manual (ver `listInvoicingIssuesHandler`). */
const MAX_AUTO_RECONCILE_RETRIES = 10;

/** Estados terminales: no corresponde reintentar emisión ni volver a contabilizar. */
const TERMINAL_STATUSES: FiscalInvoiceStatus[] = [
  FiscalInvoiceStatus.authorized,
  FiscalInvoiceStatus.rejected,
  FiscalInvoiceStatus.cancelled,
];

function idempotencyKey(businessId: string, orderId: string, kind: FiscalInvoiceKind): string {
  return `${businessId}:${orderId}:${kind}`;
}

/** `true` únicamente si el P2002 corresponde a la unicidad (business_id, order_id, kind) de `fiscal_invoice`. */
function isFiscalInvoiceUniqueConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code !== "P2002") return false;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  if (typeof target === "string") return target.includes("unique_fiscal_invoice_business_order_kind");
  if (Array.isArray(target)) return target.includes("order_id") && target.includes("kind");
  return false;
}

async function buildLineItems(orderId: string): Promise<FiscalInvoiceLineItem[]> {
  const items = await prisma.order_item.findMany({
    where: { order_id: orderId },
    include: { menu_item: { select: { name: true } } },
  });
  return items.map((item) => {
    const discount = item.discount_amount ? Number(item.discount_amount) : 0;
    const gross = Number(item.unit_price) * item.quantity - discount;
    return {
      description: item.variation ? `${item.menu_item.name} (${item.variation})` : item.menu_item.name,
      quantity: 1,
      unitPrice: gross,
      vatRate: 21,
    };
  });
}

/**
 * Agrega al detalle los conceptos que `orders` registra a nivel de pedido (envío, ajuste de
 * pago, descuento promocional) para que `sum(detalle) === order.total_amount` — ver FASE 6:
 * no enviar un comprobante cuyo detalle no reconcilie con el total real de la operación.
 */
function appendOrderLevelAdjustments(
  items: FiscalInvoiceLineItem[],
  order: { delivery_fee: Prisma.Decimal | null; payment_adjustment: Prisma.Decimal | null; promotion_discount: Prisma.Decimal | null }
): FiscalInvoiceLineItem[] {
  const result = [...items];
  if (order.delivery_fee && Number(order.delivery_fee) !== 0) {
    result.push({ description: "Envío", quantity: 1, unitPrice: Number(order.delivery_fee), vatRate: 21 });
  }
  if (order.payment_adjustment && Number(order.payment_adjustment) !== 0) {
    result.push({ description: "Ajuste de pago", quantity: 1, unitPrice: Number(order.payment_adjustment), vatRate: 21 });
  }
  if (order.promotion_discount && Number(order.promotion_discount) !== 0) {
    result.push({ description: "Descuento promocional", quantity: 1, unitPrice: -Number(order.promotion_discount), vatRate: 21 });
  }
  return result;
}

function buildCustomer(customer: { name: string | null; phone_number: string }): FiscalCustomer {
  return {
    documentType: "CONSUMIDOR_FINAL",
    documentNumber: null,
    name: customer.name || "Consumidor Final",
    email: null,
    address: null,
    condicionIva: "CF",
  };
}

type ClaimDecision =
  | { action: "return_existing"; invoice: fiscal_invoice; emitted: boolean; reason: string }
  | { action: "issue"; invoice: fiscal_invoice }
  | { action: "reconcile"; invoice: fiscal_invoice };

function decideFromExisting(existing: fiscal_invoice): ClaimDecision | "claim" {
  if (TERMINAL_STATUSES.includes(existing.status)) {
    return {
      action: "return_existing",
      invoice: existing,
      emitted: existing.status === FiscalInvoiceStatus.authorized,
      reason: existing.status,
    };
  }

  if (existing.status === FiscalInvoiceStatus.pending || existing.status === FiscalInvoiceStatus.failed) {
    // pending: recién creada, nadie la contactó todavía. failed: falló ANTES de contactar al
    // proveedor (ver `markFailedBeforeSend`) — en ambos casos, reintentar con `issueInvoice` es seguro.
    return "claim";
  }

  if (existing.status === FiscalInvoiceStatus.processing) {
    const staleMs = Date.now() - existing.updated_at.getTime();
    if (staleMs < PROCESSING_STALE_MS) {
      // Otro proceso la está resolviendo en este momento: no competir, devolver el estado actual.
      return { action: "return_existing", invoice: existing, emitted: false, reason: "in_progress" };
    }
    // Abandonada (el proceso que la reclamó murió a mitad de camino): no sabemos si llegó al
    // proveedor — reconciliar antes de volver a emitir (FASE 2), nunca reintentar a ciegas.
    return { action: "reconcile", invoice: existing };
  }

  // requires_review: resultado incierto tras un intento anterior — reconciliar, nunca reemitir,
  // salvo que ya se agotaron los reintentos automáticos (entonces queda para revisión manual).
  if (existing.retry_count >= MAX_AUTO_RECONCILE_RETRIES) {
    return { action: "return_existing", invoice: existing, emitted: false, reason: "manual_review_required" };
  }
  return { action: "reconcile", invoice: existing };
}

/**
 * Fase de reclamo: lee/crea la fila y, si corresponde emitir, la marca `processing` de forma
 * atómica. Debe ejecutarse SIEMPRE dentro de `withBillingLock` — es la única sección que decide
 * si se va a llamar a una operación mutante del proveedor (`issueInvoice`), que no es segura de
 * invocar dos veces en paralelo para la misma clave. Es puramente de base de datos (rápida): el
 * lock nunca debe cubrir la llamada de red posterior.
 */
async function claimInvoiceRow(
  businessId: string,
  orderId: string,
  kind: FiscalInvoiceKind,
  key: string,
  provider: string,
  amount: number,
  currencyCode: string,
  providerEnvironment: string | null
): Promise<ClaimDecision> {
  const existing = await prisma.fiscal_invoice.findUnique({
    where: { business_id_order_id_kind: { business_id: businessId, order_id: orderId, kind } },
  });

  if (!existing) {
    try {
      const created = await prisma.fiscal_invoice.create({
        data: {
          business_id: businessId,
          order_id: orderId,
          kind,
          provider,
          provider_environment: providerEnvironment,
          idempotency_key: key,
          amount,
          currency_code: currencyCode,
          status: FiscalInvoiceStatus.processing,
        },
      });
      return { action: "issue", invoice: created };
    } catch (err) {
      if (!isFiscalInvoiceUniqueConflict(err)) throw err;
      // Dentro del lock esto no debería pasar; si pasa (p. ej. una fila creada por un camino que
      // no pasó por este lock), se trata igual que una fila existente en vez de fallar.
      const raced = await prisma.fiscal_invoice.findUniqueOrThrow({
        where: { business_id_order_id_kind: { business_id: businessId, order_id: orderId, kind } },
      });
      return claimOrDecide(raced);
    }
  }

  return claimOrDecide(existing);
}

async function claimOrDecide(existing: fiscal_invoice): Promise<ClaimDecision> {
  const decision = decideFromExisting(existing);
  if (decision !== "claim") return decision;

  const claimed = await prisma.fiscal_invoice.update({
    where: { id: existing.id },
    data: { status: FiscalInvoiceStatus.processing, updated_at: new Date() },
  });
  return { action: "issue", invoice: claimed };
}

async function markFailedBeforeSend(invoiceId: string, err: unknown): Promise<fiscal_invoice> {
  return prisma.fiscal_invoice.update({
    where: { id: invoiceId },
    data: {
      status: FiscalInvoiceStatus.failed,
      error_message: err instanceof Error ? err.message : "Error local antes de contactar al proveedor",
      retry_count: { increment: 1 },
      updated_at: new Date(),
    },
  });
}

/** Resultado incierto (red, timeout, o persistencia fallida tras una respuesta real) — nunca "failed". */
async function markRequiresReview(invoiceId: string, err: unknown): Promise<fiscal_invoice> {
  await prisma.fiscal_invoice.updateMany({
    where: { id: invoiceId, status: { notIn: TERMINAL_STATUSES } },
    data: {
      status: FiscalInvoiceStatus.requires_review,
      error_message: err instanceof Error ? err.message : "Resultado desconocido, pendiente de reconciliar",
      retry_count: { increment: 1 },
      updated_at: new Date(),
    },
  });
  return prisma.fiscal_invoice.findUniqueOrThrow({ where: { id: invoiceId } });
}

/**
 * Marca una fila como pendiente de intervención porque el proveedor no pudo resolverse
 * localmente (sin token central configurado/activo, p. ej.) — a diferencia de
 * `markRequiresReview`, NO incrementa `retry_count`: no se ejecutó ninguna consulta remota, así
 * que no corresponde contarla como un intento real (hallazgo "comprobantes pendientes al
 * desactivar el proveedor"). Reusa `requires_review` (ya visible para el SUPER_ADMIN en
 * `listInvoicingIssuesHandler`) en vez de crear un estado/cola nueva. Como la fila permanece en
 * `requires_review` (dentro del filtro de `reconcilePendingInvoices`), el siguiente ciclo del
 * worker vuelve a intentar resolver el proveedor automáticamente — no hace falta un mecanismo
 * separado para "retomar" la reconciliación cuando se restablezca la configuración central.
 */
async function markProviderUnavailable(invoiceId: string, detail: string): Promise<fiscal_invoice> {
  await prisma.fiscal_invoice.updateMany({
    where: { id: invoiceId, status: { notIn: TERMINAL_STATUSES } },
    data: {
      status: FiscalInvoiceStatus.requires_review,
      error_message: detail,
      updated_at: new Date(),
    },
  });
  return prisma.fiscal_invoice.findUniqueOrThrow({ where: { id: invoiceId } });
}

/**
 * Persiste el resultado del proveedor de forma atómica: la condición `status NOT IN (terminal)`
 * en el `WHERE` hace que, bajo Postgres (read-committed, lock de fila en el UPDATE), si dos
 * llamados concurrentes (webhook + worker, dos workers, etc.) persisten el mismo resultado
 * "authorized" para la misma fila, solo el primero en comprometerse la encuentre todavía no-terminal
 * (`count === 1`); el segundo la vuelve a leer ya en estado terminal y no matchea (`count === 0`).
 * `recordVoucherAuthorized` solo se llama cuando `count === 1` — contabilización exactamente una vez
 * (FASE 3), sin necesidad de lock para esta parte.
 */
async function persistProviderResult(
  invoiceId: string,
  result: FiscalInvoiceResult
): Promise<InvoiceEmissionOutcome> {
  const newStatus = result.status as FiscalInvoiceStatus;
  try {
    const updateResult = await prisma.fiscal_invoice.updateMany({
      where: { id: invoiceId, status: { notIn: TERMINAL_STATUSES } },
      data: {
        status: newStatus,
        provider_invoice_id: result.providerInvoiceId,
        voucher_type: result.voucherType,
        comprobante_numero: result.comprobanteNumero,
        cae: result.cae,
        cae_vencimiento: result.caeVencimiento ? new Date(result.caeVencimiento) : null,
        issued_at: newStatus === FiscalInvoiceStatus.authorized ? new Date() : undefined,
        pdf_url: result.pdfUrl,
        provider_response: result.raw as Prisma.InputJsonValue,
        error_message: result.errorMessage,
        updated_at: new Date(),
      },
    });

    const invoice = await prisma.fiscal_invoice.findUniqueOrThrow({ where: { id: invoiceId } });

    if (updateResult.count === 1 && newStatus === FiscalInvoiceStatus.authorized) {
      await recordVoucherAuthorized(invoice.business_id).catch((err) => {
        console.error("[Invoicing] Error registrando consumo comercial:", err);
      });
    }

    return { emitted: invoice.status === FiscalInvoiceStatus.authorized, invoice };
  } catch (err) {
    // El proveedor YA respondió (podría incluso haber autorizado), pero no pudimos persistirlo:
    // para nuestro lado el resultado queda incierto — jamás "failed" (eso implicaría que es seguro
    // reemitir a ciegas, y no lo es). La próxima reconciliación lo recupera vía `getInvoiceStatus`.
    const updated = await markRequiresReview(invoiceId, err);
    return { emitted: false, invoice: updated, reason: "persist_error_after_provider_response" };
  }
}

async function runIssue(
  provider: BillingProvider,
  row: fiscal_invoice,
  request: IssueInvoiceRequest
): Promise<InvoiceEmissionOutcome> {
  void recordProviderRequest(row.business_id).catch(() => undefined);

  let result: FiscalInvoiceResult;
  try {
    result = await provider.issueInvoice(request);
  } catch (err) {
    // No sabemos con certeza si el proveedor recibió la solicitud (timeout, red, 5xx):
    // nunca asumir que no — queda recuperable, se reconcilia antes de cualquier reintento.
    if (err instanceof BillingProviderRejectionError) {
      const updated = await prisma.fiscal_invoice.update({
        where: { id: row.id },
        data: {
          status: FiscalInvoiceStatus.rejected,
          error_message: err.message,
          retry_count: { increment: 1 },
          updated_at: new Date(),
        },
      });
      return { emitted: false, invoice: updated, reason: "rejected" };
    }
    const updated = await markRequiresReview(row.id, err);
    return { emitted: false, invoice: updated, reason: "provider_error_uncertain" };
  }

  return persistProviderResult(row.id, result);
}

async function runReconcile(
  provider: BillingProvider,
  row: fiscal_invoice,
  key: string
): Promise<InvoiceEmissionOutcome> {
  try {
    const result = await provider.getInvoiceStatus(key);
    return await persistProviderResult(row.id, result);
  } catch (err) {
    const updated = await markRequiresReview(row.id, err);
    return { emitted: false, invoice: updated, reason: "reconciliation_error" };
  }
}

/**
 * Orquesta la emisión de un comprobante para un pedido ya pagado.
 *
 * Idempotente y seguro ante concurrencia entre procesos/instancias (FASE 1):
 *  - A lo sumo una fila por (business_id, order_id, kind) — `@@unique` en `fiscal_invoice`.
 *  - La decisión de llamar a `issueInvoice` (operación mutante, no segura de duplicar) se toma
 *    dentro de `withBillingLock` (namespace propio `INVOICING_EMISSION_NAMESPACE`), que es un
 *    advisory lock de Postgres — funciona entre instancias del backend, no solo en este proceso.
 *    El lock se libera ANTES de la llamada de red al proveedor (nunca cubre I/O prolongado).
 *  - La emisión sí mantiene el lock por negocio de `fiscal_configuration` durante la última
 *    comprobación CUIT↔emisor y el envío, para que un cambio de CUIT no intercale la identidad.
 *  - La persistencia del resultado es atómica vía `persistProviderResult` (FASE 2/3) y no depende
 *    del lock: un proceso que pierde la carrera de reclamo nunca termina en un error genérico,
 *    recibe `{ emitted:false, reason:'in_progress', invoice }` con la fila real.
 *
 * No lanza para condiciones de negocio esperables (addon desactivado, configuración incompleta,
 * pedido no pagado, moneda sin cotización, detalle inconsistente): devuelve `{ emitted:false, reason }`
 * para que el llamador (hooks de pagos/pedidos, siempre en modo fire-and-forget) nunca bloquee ni
 * revierta la operación que lo disparó.
 */
export async function requestInvoiceEmission(
  businessId: string,
  orderId: string,
  kind: FiscalInvoiceKind = FiscalInvoiceKind.invoice
): Promise<InvoiceEmissionOutcome> {
  if (!(await isInvoicingAddonEnabled(businessId))) {
    return { emitted: false, reason: "addon_disabled" };
  }

  const order = await prisma.orders.findFirst({
    where: { id: orderId, business_id: businessId },
    include: { customer: { select: { name: true, phone_number: true } } },
  });
  if (!order) return { emitted: false, reason: "order_not_found" };
  if (order.payment_status !== "paid") return { emitted: false, reason: "order_not_paid" };
  if (order.total_amount === null || Number(order.total_amount) <= 0) {
    return { emitted: false, reason: "order_total_missing" };
  }

  // Sin una fuente de cotización confiable integrada, no inventamos un valor (FASE 5): se bloquea
  // la emisión en vez de enviar `cotizacion: 1` para una moneda que no es la local.
  if (order.currency_code !== "ARS") {
    return { emitted: false, reason: "unsupported_currency_requires_fx" };
  }

  let fiscalConfig = await getFiscalConfiguration(businessId);
  if (!fiscalConfig || !fiscalConfig.cuit) {
    return { emitted: false, reason: "fiscal_configuration_incomplete" };
  }

  // Sistemas 360 opera con cuenta central + `emisor_id` por negocio (ver
  // `emisorProvisioning.service.ts`): solo se acepta una asociación con prueba local de que
  // pertenece al CUIT vigente. Las asociaciones previas a ese registro se vuelven a resolver.
  const normalizedCuit = fiscalConfig.cuit.replace(/\D/g, "");
  const providerEnvironment = await resolveCurrentEnvironment();
  if (
    !providerEnvironment ||
    !fiscalConfig.external_issuer_id ||
    fiscalConfig.external_issuer_environment !== providerEnvironment ||
    (fiscalConfig.external_issuer_cuit ?? "").replace(/\D/g, "") !== normalizedCuit
  ) {
    const provisioning = await ensureEmisorProvisioned(businessId);
    if (!provisioning.provisioned) {
      return { emitted: false, reason: "emisor_not_provisioned" };
    }
    fiscalConfig = await getFiscalConfiguration(businessId);
    if (
      !fiscalConfig?.cuit ||
      !fiscalConfig.external_issuer_id ||
      fiscalConfig.external_issuer_environment !== providerEnvironment ||
      (fiscalConfig.external_issuer_cuit ?? "").replace(/\D/g, "") !==
        fiscalConfig.cuit.replace(/\D/g, "")
    ) {
      return { emitted: false, reason: "emisor_not_provisioned" };
    }
  }

  if (!fiscalConfig) return { emitted: false, reason: "fiscal_configuration_incomplete" };
  const provider = await resolveBillingProvider(businessId);
  if (!provider) {
    return { emitted: false, reason: "provider_not_configured" };
  }

  const voucherType = resolveVoucherTypeForConsumidorFinal(
    (fiscalConfig.condicion_iva ?? "NO_CATEGORIZADO") as CondicionIva
  );
  if (!voucherType) {
    return { emitted: false, reason: "voucher_type_undetermined" };
  }

  let items: FiscalInvoiceLineItem[];
  try {
    items = appendOrderLevelAdjustments(await buildLineItems(orderId), order);
  } catch {
    return { emitted: false, reason: "line_items_build_error" };
  }

  const itemsTotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  // Tolerancia de 1 centavo por redondeo de punto flotante — no por laxitud de negocio.
  if (Math.abs(itemsTotal - Number(order.total_amount)) > 0.01) {
    return { emitted: false, reason: "line_items_total_mismatch" };
  }

  const key = idempotencyKey(businessId, orderId, kind);
  // Capturado una sola vez, ANTES de reclamar la fila: queda inmutable en `provider_environment`
  // para que una reconciliación futura nunca use un entorno distinto del que existía al emitir
  // (hallazgo "aislamiento del entorno de emisión").
  let claim: ClaimDecision;
  try {
    claim = await withBillingLock(INVOICING_EMISSION_NAMESPACE, key, () =>
      claimInvoiceRow(
        businessId,
        orderId,
        kind,
        key,
        "sistemas360",
        Number(order.total_amount),
        order.currency_code,
        providerEnvironment
      )
    );
  } catch (err) {
    if (err instanceof BillingLockTimeoutError || err instanceof BillingLockUnavailableError) {
      return { emitted: false, reason: "lock_unavailable" };
    }
    throw err;
  }

  if (claim.action === "return_existing") {
    return { emitted: claim.emitted, invoice: claim.invoice, reason: claim.reason };
  }

  if (claim.action === "reconcile") {
    // La fila ya existía: reconciliar con SU entorno original, no con el que se resolvió arriba
    // para una emisión nueva (pueden diferir si el entorno central cambió entre medio) — mismo
    // criterio que `reconcilePendingInvoices`.
    const reconcileProvider = claim.invoice.provider_environment
      ? await resolveBillingProvider(businessId, {
          environment: claim.invoice.provider_environment as "sandbox" | "production",
        })
      : provider;
    if (!reconcileProvider) {
      const updated = await markProviderUnavailable(
        claim.invoice.id,
        "Sistemas 360 no está disponible para el entorno de emisión original."
      );
      return { emitted: false, invoice: updated, reason: "provider_not_configured" };
    }
    return runReconcile(reconcileProvider, claim.invoice, key);
  }

  try {
    return await withFiscalConfigurationLock(businessId, async () => {
      const currentConfig = await getFiscalConfiguration(businessId);
      if (
        !currentConfig?.cuit ||
        !currentConfig.external_issuer_id ||
        currentConfig.external_issuer_environment !== providerEnvironment ||
        (currentConfig.external_issuer_cuit ?? "").replace(/\D/g, "") !==
          currentConfig.cuit.replace(/\D/g, "")
      ) {
        const failed = await markFailedBeforeSend(
          claim.invoice.id,
          new Error("La asociación del emisor no corresponde al CUIT fiscal vigente.")
        );
        return { emitted: false, invoice: failed, reason: "emisor_not_provisioned" };
      }

      const currentVoucherType = resolveVoucherTypeForConsumidorFinal(
        (currentConfig.condicion_iva ?? "NO_CATEGORIZADO") as CondicionIva
      );
      if (!currentVoucherType) {
        const failed = await markFailedBeforeSend(
          claim.invoice.id,
          new Error("No se pudo determinar el tipo de comprobante para la condición fiscal vigente.")
        );
        return { emitted: false, invoice: failed, reason: "voucher_type_undetermined" };
      }

      const request: IssueInvoiceRequest = {
        externalReference: key,
        voucherType: currentVoucherType,
        issuer: {
          cuit: currentConfig.cuit,
          razonSocial: currentConfig.razon_social ?? "",
          condicionIva: (currentConfig.condicion_iva ?? "NO_CATEGORIZADO") as CondicionIva,
          domicilioFiscal: currentConfig.domicilio_fiscal ?? "",
          externalIssuerId: currentConfig.external_issuer_id,
        },
        customer: buildCustomer(order.customer),
        items,
        totalAmount: Number(order.total_amount),
        currencyCode: order.currency_code,
      };

      return runIssue(provider, claim.invoice, request);
    });
  } catch (err) {
    if (err instanceof BillingLockTimeoutError || err instanceof BillingLockUnavailableError) {
      const failed = await markFailedBeforeSend(claim.invoice.id, err);
      return { emitted: false, invoice: failed, reason: "fiscal_configuration_lock_unavailable" };
    }
    throw err;
  }
}

/**
 * Punto de entrada para los hooks de pagos/pedidos (FASE 5 del encargo original). Respeta la
 * configuración por restaurante (`auto_issue_online` / `auto_issue_cash`) y nunca lanza: los
 * llamadores deben invocarla en modo "fire and forget"
 * (`void triggerAutomaticInvoiceEmission(...).catch(...)`) para no bloquear el checkout ni la
 * gestión del pedido si el proveedor está caído.
 */
export async function triggerAutomaticInvoiceEmission(
  businessId: string,
  orderId: string,
  paymentChannel: "online" | "cash"
): Promise<InvoiceEmissionOutcome> {
  const fiscalConfig = await getFiscalConfiguration(businessId);
  if (!fiscalConfig) return { emitted: false, reason: "fiscal_configuration_missing" };

  const autoIssue = paymentChannel === "online" ? fiscalConfig.auto_issue_online : fiscalConfig.auto_issue_cash;
  if (!autoIssue) return { emitted: false, reason: "auto_issue_disabled" };

  return requestInvoiceEmission(businessId, orderId, FiscalInvoiceKind.invoice);
}

export async function getInvoicesForOrder(businessId: string, orderId: string): Promise<fiscal_invoice[]> {
  return prisma.fiscal_invoice.findMany({
    where: { business_id: businessId, order_id: orderId },
    orderBy: { created_at: "desc" },
  });
}

/** Mismo patrón que `adminOrders.service.ts`/`adminReservations.service.ts`: acepta "YYYY-MM-DD" (día completo en UTC) o un ISO completo. */
function parseDateFrom(s: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return dayjs.utc(s).startOf("day").toDate();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error("INVALID_DATE_FROM");
  return d;
}

function parseDateTo(s: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return dayjs.utc(s).endOf("day").toDate();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error("INVALID_DATE_TO");
  return d;
}

export async function listInvoices(
  businessId: string,
  options: {
    status?: FiscalInvoiceStatus;
    dateFrom?: string;
    dateTo?: string;
    take?: number;
    skip?: number;
  } = {}
): Promise<fiscal_invoice[]> {
  const createdAt: Prisma.DateTimeFilter = {};
  if (options.dateFrom) createdAt.gte = parseDateFrom(options.dateFrom);
  if (options.dateTo) createdAt.lte = parseDateTo(options.dateTo);

  return prisma.fiscal_invoice.findMany({
    where: {
      business_id: businessId,
      ...(options.status ? { status: options.status } : {}),
      ...(options.dateFrom || options.dateTo ? { created_at: createdAt } : {}),
    },
    orderBy: { created_at: "desc" },
    take: options.take ?? 50,
    skip: options.skip ?? 0,
  });
}

/**
 * Worker de reconciliación (FASE 4/8 del encargo original): recupera el estado real de
 * operaciones en curso o con resultado desconocido — nunca reintenta `issueInvoice`, solo lee
 * (`getInvoiceStatus`). Seguro entre instancias: la persistencia es atómica (`persistProviderResult`)
 * y no requiere coordinación entre workers.
 *
 * Orden estable por antigüedad (`created_at asc`) y tope de reintentos automáticos
 * (`MAX_AUTO_RECONCILE_RETRIES`): una fila que nunca logra resolverse deja de reprocesarse sola
 * (evita monopolizar los cupos del worker) y queda visible para revisión manual
 * (`listInvoicingIssuesHandler`) en vez de reintentarse indefinidamente.
 */
export async function reconcilePendingInvoices(
  limit = 50
): Promise<{ reconciled: number; providerUnavailable: number; skippedForManualReview: number }> {
  const pending = await prisma.fiscal_invoice.findMany({
    where: {
      status: { in: [FiscalInvoiceStatus.processing, FiscalInvoiceStatus.requires_review] },
      retry_count: { lt: MAX_AUTO_RECONCILE_RETRIES },
    },
    orderBy: { created_at: "asc" },
    take: limit,
  });

  let reconciled = 0;
  let providerUnavailable = 0;
  for (const invoice of pending) {
    // Reconciliar con el entorno en el que se INICIÓ esta operación, no con el activo ahora
    // (hallazgo "aislamiento del entorno de emisión") — conservador: `provider_environment` nulo
    // usa el entorno activo actual.
    const provider = await resolveBillingProvider(
      invoice.business_id,
      invoice.provider_environment
        ? { environment: invoice.provider_environment as "sandbox" | "production" }
        : undefined
    );
    if (!provider) {
      // Nunca desaparece del circuito de recuperación por estar el proveedor desactivado: queda
      // marcada (`requires_review`, visible para SUPER_ADMIN) sin incrementar `retry_count` (no
      // se ejecutó ninguna consulta remota) y sin convertirse en `failed`. El próximo ciclo la
      // vuelve a intentar — se retoma sola cuando se restablezca la configuración del proveedor.
      await markProviderUnavailable(
        invoice.id,
        "Sistemas 360 no está disponible o no tiene token para el entorno de emisión original. Pendiente de que se restablezca la configuración."
      );
      providerUnavailable += 1;
      continue;
    }
    const outcome = await runReconcile(provider, invoice, invoice.idempotency_key);
    if (outcome.reason !== "reconciliation_error") reconciled += 1;
  }

  const skippedForManualReview = await prisma.fiscal_invoice.count({
    where: {
      status: { in: [FiscalInvoiceStatus.processing, FiscalInvoiceStatus.requires_review] },
      retry_count: { gte: MAX_AUTO_RECONCILE_RETRIES },
    },
  });

  return { reconciled, providerUnavailable, skippedForManualReview };
}
