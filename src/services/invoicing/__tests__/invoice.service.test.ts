import { describe, expect, it, vi, beforeEach } from "vitest";
import { FiscalInvoiceKind, FiscalInvoiceStatus, Prisma } from "@prisma/client";

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    orders: { findFirst: vi.fn() },
    order_item: { findMany: vi.fn() },
    fiscal_invoice: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("../fiscalConfiguration.service", () => ({
  getFiscalConfiguration: vi.fn(),
}));

vi.mock("../emisorProvisioning.service", () => ({
  ensureEmisorProvisioned: vi.fn(),
}));

vi.mock("../invoicingAddon.service", () => ({
  isInvoicingAddonEnabled: vi.fn(),
}));

vi.mock("../billingProviderFactory", () => ({
  resolveBillingProvider: vi.fn(),
  resolveCurrentEnvironment: vi.fn().mockResolvedValue("sandbox"),
}));

vi.mock("../invoicingUsage.service", () => ({
  recordProviderRequest: vi.fn().mockResolvedValue(undefined),
  recordVoucherAuthorized: vi.fn().mockResolvedValue(undefined),
}));

// Lock real (pg_advisory_lock) reemplazado por una ejecución directa del callback: estos tests
// verifican la lógica de reclamo/decisión, no el advisory lock de Postgres en sí (eso requeriría
// una base real — ver informe de cierre, sección de riesgos que permanecen).
vi.mock("../../billing/billingLock", () => {
  class BillingLockTimeoutError extends Error {}
  class BillingLockUnavailableError extends Error {}
  return {
    withBillingLock: vi.fn((_namespace: string, _key: string, fn: () => unknown) => fn()),
    BillingLockTimeoutError,
    BillingLockUnavailableError,
  };
});

import { prisma } from "../../../lib/prisma";
import { getFiscalConfiguration } from "../fiscalConfiguration.service";
import { ensureEmisorProvisioned } from "../emisorProvisioning.service";
import { isInvoicingAddonEnabled } from "../invoicingAddon.service";
import { resolveBillingProvider } from "../billingProviderFactory";
import { recordVoucherAuthorized } from "../invoicingUsage.service";
import { withBillingLock } from "../../billing/billingLock";
import {
  requestInvoiceEmission,
  reconcilePendingInvoices,
  listInvoices,
} from "../invoice.service";

function mocked(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

/**
 * Mock mínimo de `BillingProvider` para estos tests. `getIssuerCondicionIva` default resuelve
 * `"RI"` — coincide con `baseFiscalConfig().condicion_iva` para no alterar las expectativas ya
 * existentes (`voucherType: "B"`) ahora que la resolución del tipo de comprobante consulta al
 * provider en vez de leer la config local directamente.
 */
function buildProvider(overrides: Record<string, unknown> = {}): unknown {
  return {
    getIssuerCondicionIva: vi.fn().mockResolvedValue("RI"),
    ...overrides,
  };
}

const BUSINESS_A = "business-a";
const ORDER_1 = "order-1";

function baseFiscalConfig() {
  return {
    business_id: BUSINESS_A,
    cuit: "20123456786",
    razon_social: "Restaurante Test",
    condicion_iva: "RI",
    domicilio_fiscal: "Calle Falsa 123",
    punto_venta: 3,
    external_issuer_id: "100",
    external_issuer_cuit: "20123456786",
    external_issuer_environment: "sandbox",
    auto_issue_online: true,
    auto_issue_cash: false,
    status: "validated",
  };
}

function baseOrder() {
  return {
    id: ORDER_1,
    business_id: BUSINESS_A,
    payment_status: "paid",
    total_amount: 1000,
    currency_code: "ARS",
    delivery_fee: null,
    payment_adjustment: null,
    promotion_discount: null,
    customer: { name: "Juan Pérez", phone_number: "5491100000000" },
  };
}

/** Un único ítem cuyo total coincide exactamente con `baseOrder().total_amount` (1000). */
function matchingOrderItems() {
  return [
    {
      quantity: 1,
      unit_price: 1000,
      discount_amount: null,
      variation: null,
      menu_item: { name: "Milanesa napolitana" },
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked(prisma.order_item.findMany).mockResolvedValue(matchingOrderItems());
});

describe("requestInvoiceEmission", () => {
  it("no emite si el add-on de facturación está desactivado", async () => {
    mocked(isInvoicingAddonEnabled).mockResolvedValue(false);

    const outcome = await requestInvoiceEmission(BUSINESS_A, ORDER_1, FiscalInvoiceKind.invoice);

    expect(outcome).toEqual({ emitted: false, reason: "addon_disabled" });
    expect(prisma.orders.findFirst).not.toHaveBeenCalled();
  });

  it("no emite si el pedido no está pagado", async () => {
    mocked(isInvoicingAddonEnabled).mockResolvedValue(true);
    mocked(prisma.orders.findFirst).mockResolvedValue({ ...baseOrder(), payment_status: "unpaid" });

    const outcome = await requestInvoiceEmission(BUSINESS_A, ORDER_1, FiscalInvoiceKind.invoice);

    expect(outcome).toEqual({ emitted: false, reason: "order_not_paid" });
  });

  it("no emite si la configuración fiscal está incompleta", async () => {
    mocked(isInvoicingAddonEnabled).mockResolvedValue(true);
    mocked(prisma.orders.findFirst).mockResolvedValue(baseOrder());
    mocked(getFiscalConfiguration).mockResolvedValue({ ...baseFiscalConfig(), cuit: null });

    const outcome = await requestInvoiceEmission(BUSINESS_A, ORDER_1, FiscalInvoiceKind.invoice);

    expect(outcome).toEqual({ emitted: false, reason: "fiscal_configuration_incomplete" });
  });

  it("no reutiliza una asociación cuya correspondencia con el CUIT vigente no está probada", async () => {
    mocked(isInvoicingAddonEnabled).mockResolvedValue(true);
    mocked(prisma.orders.findFirst).mockResolvedValue(baseOrder());
    mocked(getFiscalConfiguration).mockResolvedValue({
      ...baseFiscalConfig(),
      cuit: "27234567891",
      external_issuer_cuit: "20123456786",
    });
    mocked(ensureEmisorProvisioned).mockResolvedValue({
      provisioned: false,
      externalIssuerId: null,
      status: "not_configured",
      detail: "No se pudo asociar.",
    });

    const outcome = await requestInvoiceEmission(BUSINESS_A, ORDER_1, FiscalInvoiceKind.invoice);

    expect(ensureEmisorProvisioned).toHaveBeenCalledWith(BUSINESS_A);
    expect(resolveBillingProvider).not.toHaveBeenCalled();
    expect(outcome).toEqual({ emitted: false, reason: "emisor_not_provisioned" });
  });

  it("bloquea el envío si el CUIT cambia entre la carga inicial y el envío al proveedor", async () => {
    mocked(isInvoicingAddonEnabled).mockResolvedValue(true);
    mocked(prisma.orders.findFirst).mockResolvedValue(baseOrder());
    mocked(getFiscalConfiguration)
      .mockResolvedValueOnce(baseFiscalConfig())
      .mockResolvedValueOnce({
        ...baseFiscalConfig(),
        cuit: "27234567891",
      });
    mocked(prisma.fiscal_invoice.findUnique).mockResolvedValue(null);
    const claimedRow = {
      id: "inv-race",
      business_id: BUSINESS_A,
      status: FiscalInvoiceStatus.processing,
    };
    mocked(prisma.fiscal_invoice.create).mockResolvedValue(claimedRow);
    mocked(prisma.fiscal_invoice.update).mockResolvedValue({
      ...claimedRow,
      status: FiscalInvoiceStatus.failed,
    });
    const issueInvoice = vi.fn();
    mocked(resolveBillingProvider).mockResolvedValue(buildProvider({ issueInvoice }));

    const outcome = await requestInvoiceEmission(BUSINESS_A, ORDER_1, FiscalInvoiceKind.invoice);

    expect(issueInvoice).not.toHaveBeenCalled();
    expect(withBillingLock).toHaveBeenCalledWith(
      "gesty:invoicing:emisor-provisioning",
      BUSINESS_A,
      expect.any(Function)
    );
    expect(outcome).toMatchObject({
      emitted: false,
      reason: "emisor_not_provisioned",
      invoice: { status: FiscalInvoiceStatus.failed },
    });
  });

  it("emite y autoriza un comprobante nuevo (camino feliz)", async () => {
    mocked(isInvoicingAddonEnabled).mockResolvedValue(true);
    mocked(prisma.orders.findFirst).mockResolvedValue(baseOrder());
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig());
    mocked(prisma.fiscal_invoice.findUnique).mockResolvedValue(null);

    const createdRow = { id: "inv-1", business_id: BUSINESS_A, status: FiscalInvoiceStatus.processing };
    mocked(prisma.fiscal_invoice.create).mockResolvedValue(createdRow);

    const issueInvoice = vi.fn().mockResolvedValue({
      status: "authorized",
      providerInvoiceId: "ext-1",
      voucherType: "B",
      comprobanteNumero: 10,
      cae: "71234567890123",
      caeVencimiento: "2027-01-01",
      pdfUrl: "https://example.com/pdf",
      errorMessage: null,
      raw: {},
    });
    mocked(resolveBillingProvider).mockResolvedValue(buildProvider({ issueInvoice }));
    mocked(prisma.fiscal_invoice.updateMany).mockResolvedValue({ count: 1 });
    mocked(prisma.fiscal_invoice.findUniqueOrThrow).mockResolvedValue({
      ...createdRow,
      status: FiscalInvoiceStatus.authorized,
    });

    const outcome = await requestInvoiceEmission(BUSINESS_A, ORDER_1, FiscalInvoiceKind.invoice);

    expect(withBillingLock).toHaveBeenCalledWith(
      "gesty:invoicing:emission",
      `${BUSINESS_A}:${ORDER_1}:invoice`,
      expect.any(Function)
    );
    expect(issueInvoice).toHaveBeenCalledTimes(1);
    expect(outcome.emitted).toBe(true);
    expect(outcome.invoice?.status).toBe(FiscalInvoiceStatus.authorized);
    expect(recordVoucherAuthorized).toHaveBeenCalledTimes(1);
  });

  it("es idempotente: si ya existe un comprobante autorizado, no vuelve a llamar al proveedor", async () => {
    mocked(isInvoicingAddonEnabled).mockResolvedValue(true);
    mocked(prisma.orders.findFirst).mockResolvedValue(baseOrder());
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig());

    const existing = {
      id: "inv-1",
      business_id: BUSINESS_A,
      order_id: ORDER_1,
      kind: FiscalInvoiceKind.invoice,
      status: FiscalInvoiceStatus.authorized,
    };
    mocked(prisma.fiscal_invoice.findUnique).mockResolvedValue(existing);

    const issueInvoice = vi.fn();
    mocked(resolveBillingProvider).mockResolvedValue(buildProvider({ issueInvoice }));

    const outcome = await requestInvoiceEmission(BUSINESS_A, ORDER_1, FiscalInvoiceKind.invoice);

    expect(issueInvoice).not.toHaveBeenCalled();
    expect(prisma.fiscal_invoice.create).not.toHaveBeenCalled();
    expect(outcome).toEqual({ emitted: true, invoice: existing, reason: FiscalInvoiceStatus.authorized });
  });

  it("aísla por negocio: busca el pedido acotado a business_id", async () => {
    mocked(isInvoicingAddonEnabled).mockResolvedValue(true);
    mocked(prisma.orders.findFirst).mockResolvedValue(null);

    await requestInvoiceEmission(BUSINESS_A, ORDER_1, FiscalInvoiceKind.invoice);

    expect(prisma.orders.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: ORDER_1, business_id: BUSINESS_A }) })
    );
  });

  it("dos disparadores concurrentes convergen: si la fila ya está 'processing' y reciente, no vuelve a llamar al proveedor", async () => {
    mocked(isInvoicingAddonEnabled).mockResolvedValue(true);
    mocked(prisma.orders.findFirst).mockResolvedValue(baseOrder());
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig());

    const inFlight = {
      id: "inv-1",
      business_id: BUSINESS_A,
      order_id: ORDER_1,
      kind: FiscalInvoiceKind.invoice,
      status: FiscalInvoiceStatus.processing,
      retry_count: 0,
      updated_at: new Date(), // recién tocada: otro proceso la está resolviendo ahora mismo.
    };
    mocked(prisma.fiscal_invoice.findUnique).mockResolvedValue(inFlight);

    const issueInvoice = vi.fn();
    const getInvoiceStatus = vi.fn();
    mocked(resolveBillingProvider).mockResolvedValue(buildProvider({ issueInvoice, getInvoiceStatus }));

    const outcome = await requestInvoiceEmission(BUSINESS_A, ORDER_1, FiscalInvoiceKind.invoice);

    expect(issueInvoice).not.toHaveBeenCalled();
    expect(getInvoiceStatus).not.toHaveBeenCalled();
    expect(prisma.fiscal_invoice.create).not.toHaveBeenCalled();
    expect(outcome).toEqual({ emitted: false, invoice: inFlight, reason: "in_progress" });
  });

  it("conflicto P2002 en el create (dos procesos crean al mismo tiempo): no crashea, trata la fila como existente", async () => {
    mocked(isInvoicingAddonEnabled).mockResolvedValue(true);
    mocked(prisma.orders.findFirst).mockResolvedValue(baseOrder());
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig());

    const racedRow = {
      id: "inv-1",
      business_id: BUSINESS_A,
      order_id: ORDER_1,
      kind: FiscalInvoiceKind.invoice,
      status: FiscalInvoiceStatus.authorized,
    };

    mocked(prisma.fiscal_invoice.findUnique).mockResolvedValueOnce(null);
    mocked(prisma.fiscal_invoice.create).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["order_id", "kind"] },
      })
    );
    mocked(prisma.fiscal_invoice.findUniqueOrThrow).mockResolvedValueOnce(racedRow);

    const issueInvoice = vi.fn();
    mocked(resolveBillingProvider).mockResolvedValue(buildProvider({ issueInvoice }));

    const outcome = await requestInvoiceEmission(BUSINESS_A, ORDER_1, FiscalInvoiceKind.invoice);

    expect(issueInvoice).not.toHaveBeenCalled();
    expect(outcome).toEqual({ emitted: true, invoice: racedRow, reason: FiscalInvoiceStatus.authorized });
  });

  it("respuesta exitosa del proveedor + fallo al persistir localmente: termina en requires_review, nunca en failed", async () => {
    mocked(isInvoicingAddonEnabled).mockResolvedValue(true);
    mocked(prisma.orders.findFirst).mockResolvedValue(baseOrder());
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig());
    mocked(prisma.fiscal_invoice.findUnique).mockResolvedValue(null);

    const createdRow = { id: "inv-1", business_id: BUSINESS_A, status: FiscalInvoiceStatus.processing };
    mocked(prisma.fiscal_invoice.create).mockResolvedValue(createdRow);

    const issueInvoice = vi.fn().mockResolvedValue({
      status: "authorized",
      providerInvoiceId: "ext-1",
      voucherType: "B",
      comprobanteNumero: 10,
      cae: "71234567890123",
      caeVencimiento: "2027-01-01",
      pdfUrl: null,
      errorMessage: null,
      raw: {},
    });
    mocked(resolveBillingProvider).mockResolvedValue(buildProvider({ issueInvoice }));
    // Primer updateMany (persistir el resultado del proveedor) falla; el segundo (el propio
    // `markRequiresReview`, que registra el estado incierto) sí debe poder completarse.
    mocked(prisma.fiscal_invoice.updateMany)
      .mockRejectedValueOnce(new Error("conexión a la base interrumpida"))
      .mockResolvedValue({ count: 1 });
    mocked(prisma.fiscal_invoice.findUniqueOrThrow).mockResolvedValue({
      ...createdRow,
      status: FiscalInvoiceStatus.requires_review,
    });

    const outcome = await requestInvoiceEmission(BUSINESS_A, ORDER_1, FiscalInvoiceKind.invoice);

    expect(outcome.emitted).toBe(false);
    expect(outcome.invoice?.status).toBe(FiscalInvoiceStatus.requires_review);
    expect(outcome.invoice?.status).not.toBe(FiscalInvoiceStatus.failed);
    expect(recordVoucherAuthorized).not.toHaveBeenCalled();
  });

  it("resultado desconocido (requires_review) seguido de reconciliación exitosa: consulta, nunca reemite", async () => {
    mocked(isInvoicingAddonEnabled).mockResolvedValue(true);
    mocked(prisma.orders.findFirst).mockResolvedValue(baseOrder());
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig());

    const stuck = {
      id: "inv-1",
      business_id: BUSINESS_A,
      order_id: ORDER_1,
      kind: FiscalInvoiceKind.invoice,
      status: FiscalInvoiceStatus.requires_review,
      retry_count: 1,
    };
    mocked(prisma.fiscal_invoice.findUnique).mockResolvedValue(stuck);

    const issueInvoice = vi.fn();
    const getInvoiceStatus = vi.fn().mockResolvedValue({
      status: "authorized",
      providerInvoiceId: "ext-1",
      voucherType: "B",
      comprobanteNumero: 11,
      cae: "71234567890124",
      caeVencimiento: "2027-01-01",
      pdfUrl: null,
      errorMessage: null,
      raw: {},
    });
    mocked(resolveBillingProvider).mockResolvedValue(buildProvider({ issueInvoice, getInvoiceStatus }));
    mocked(prisma.fiscal_invoice.updateMany).mockResolvedValue({ count: 1 });
    mocked(prisma.fiscal_invoice.findUniqueOrThrow).mockResolvedValue({ ...stuck, status: FiscalInvoiceStatus.authorized });

    const outcome = await requestInvoiceEmission(BUSINESS_A, ORDER_1, FiscalInvoiceKind.invoice);

    expect(issueInvoice).not.toHaveBeenCalled();
    expect(getInvoiceStatus).toHaveBeenCalledTimes(1);
    expect(outcome.emitted).toBe(true);
    expect(recordVoucherAuthorized).toHaveBeenCalledTimes(1);
  });

  it("bloquea la emisión si la moneda no es ARS (sin fuente de cotización confiable)", async () => {
    mocked(isInvoicingAddonEnabled).mockResolvedValue(true);
    mocked(prisma.orders.findFirst).mockResolvedValue({ ...baseOrder(), currency_code: "USD" });

    const outcome = await requestInvoiceEmission(BUSINESS_A, ORDER_1, FiscalInvoiceKind.invoice);

    expect(outcome).toEqual({ emitted: false, reason: "unsupported_currency_requires_fx" });
    expect(getFiscalConfiguration).not.toHaveBeenCalled();
  });

  it("bloquea la emisión si el pedido no tiene total", async () => {
    mocked(isInvoicingAddonEnabled).mockResolvedValue(true);
    mocked(prisma.orders.findFirst).mockResolvedValue({ ...baseOrder(), total_amount: null });

    const outcome = await requestInvoiceEmission(BUSINESS_A, ORDER_1, FiscalInvoiceKind.invoice);

    expect(outcome).toEqual({ emitted: false, reason: "order_total_missing" });
    expect(prisma.fiscal_invoice.create).not.toHaveBeenCalled();
  });

  it("bloquea la emisión si el detalle no coincide con el total del pedido", async () => {
    mocked(isInvoicingAddonEnabled).mockResolvedValue(true);
    mocked(prisma.orders.findFirst).mockResolvedValue(baseOrder());
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig());
    mocked(prisma.order_item.findMany).mockResolvedValue([
      { quantity: 1, unit_price: 500, discount_amount: null, variation: null, menu_item: { name: "Milanesa" } },
    ]);

    const issueInvoice = vi.fn();
    mocked(resolveBillingProvider).mockResolvedValue(buildProvider({ issueInvoice }));

    const outcome = await requestInvoiceEmission(BUSINESS_A, ORDER_1, FiscalInvoiceKind.invoice);

    expect(outcome).toEqual({ emitted: false, reason: "line_items_total_mismatch" });
    expect(issueInvoice).not.toHaveBeenCalled();
    expect(prisma.fiscal_invoice.create).not.toHaveBeenCalled();
  });

  it("reconstruye el total con envío/ajuste/descuento y permite emitir si así coincide", async () => {
    mocked(isInvoicingAddonEnabled).mockResolvedValue(true);
    mocked(prisma.orders.findFirst).mockResolvedValue({
      ...baseOrder(),
      total_amount: 1150,
      delivery_fee: 200,
      promotion_discount: 50,
    });
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig());
    mocked(prisma.fiscal_invoice.findUnique).mockResolvedValue(null);

    const createdRow = { id: "inv-1", business_id: BUSINESS_A, status: FiscalInvoiceStatus.processing };
    mocked(prisma.fiscal_invoice.create).mockResolvedValue(createdRow);

    const issueInvoice = vi.fn().mockResolvedValue({
      status: "processing",
      providerInvoiceId: null,
      voucherType: null,
      comprobanteNumero: null,
      cae: null,
      caeVencimiento: null,
      pdfUrl: null,
      errorMessage: null,
      raw: {},
    });
    mocked(resolveBillingProvider).mockResolvedValue(buildProvider({ issueInvoice }));
    mocked(prisma.fiscal_invoice.updateMany).mockResolvedValue({ count: 1 });
    mocked(prisma.fiscal_invoice.findUniqueOrThrow).mockResolvedValue({ ...createdRow, status: FiscalInvoiceStatus.processing });

    // 1000 (items) + 200 (envío) - 50 (descuento) = 1150 === total_amount.
    const outcome = await requestInvoiceEmission(BUSINESS_A, ORDER_1, FiscalInvoiceKind.invoice);

    expect(issueInvoice).toHaveBeenCalledTimes(1);
    expect(outcome.reason).not.toBe("line_items_total_mismatch");
  });

  it("el worker de reconciliación nunca llama a issueInvoice, solo a getInvoiceStatus", async () => {
    const stuck = {
      id: "inv-1",
      business_id: BUSINESS_A,
      order_id: ORDER_1,
      kind: FiscalInvoiceKind.invoice,
      status: FiscalInvoiceStatus.requires_review,
      provider: "sistemas360",
      idempotency_key: `${BUSINESS_A}:${ORDER_1}:invoice`,
      retry_count: 2,
    };
    mocked(prisma.fiscal_invoice.findMany).mockResolvedValue([stuck]);
    mocked(prisma.fiscal_invoice.count).mockResolvedValue(0);

    const issueInvoice = vi.fn();
    const getInvoiceStatus = vi.fn().mockResolvedValue({
      status: "requires_review",
      providerInvoiceId: null,
      voucherType: null,
      comprobanteNumero: null,
      cae: null,
      caeVencimiento: null,
      pdfUrl: null,
      errorMessage: "timeout",
      raw: {},
    });
    mocked(resolveBillingProvider).mockResolvedValue(buildProvider({ issueInvoice, getInvoiceStatus }));
    mocked(prisma.fiscal_invoice.updateMany).mockResolvedValue({ count: 1 });
    mocked(prisma.fiscal_invoice.findUniqueOrThrow).mockResolvedValue(stuck);

    const result = await reconcilePendingInvoices(50);

    expect(issueInvoice).not.toHaveBeenCalled();
    expect(getInvoiceStatus).toHaveBeenCalledTimes(1);
    expect(result.reconciled).toBe(1);
  });

  it("comprobantes pendientes al desactivar el proveedor: no desaparecen del circuito, quedan marcados sin incrementar retry_count ni pasar a failed", async () => {
    const stuck = {
      id: "inv-1",
      business_id: BUSINESS_A,
      order_id: ORDER_1,
      kind: FiscalInvoiceKind.invoice,
      status: FiscalInvoiceStatus.processing,
      provider: "sistemas360",
      provider_environment: null,
      idempotency_key: `${BUSINESS_A}:${ORDER_1}:invoice`,
      retry_count: 0,
    };
    mocked(prisma.fiscal_invoice.findMany).mockResolvedValue([stuck]);
    mocked(prisma.fiscal_invoice.count).mockResolvedValue(0);
    // Proveedor no disponible: sin token central configurado/activo.
    mocked(resolveBillingProvider).mockResolvedValue(null);
    mocked(prisma.fiscal_invoice.updateMany).mockResolvedValue({ count: 1 });
    mocked(prisma.fiscal_invoice.findUniqueOrThrow).mockResolvedValue({
      ...stuck,
      status: FiscalInvoiceStatus.requires_review,
    });

    const result = await reconcilePendingInvoices(50);

    expect(result.providerUnavailable).toBe(1);
    expect(result.reconciled).toBe(0);
    // Se marca vía `updateMany` (requires_review), nunca vía un `update` directo a "failed".
    const call = mocked(prisma.fiscal_invoice.updateMany).mock.calls[0][0];
    expect(call.data.status).toBe(FiscalInvoiceStatus.requires_review);
    expect(call.data.status).not.toBe(FiscalInvoiceStatus.failed);
    // No se incrementó retry_count: no se ejecutó ninguna consulta remota.
    expect(call.data).not.toHaveProperty("retry_count");
  });

  it("recupera la reconciliación automáticamente cuando se restablece la configuración del proveedor (misma fila, sin reemitir)", async () => {
    const row = {
      id: "inv-1",
      business_id: BUSINESS_A,
      order_id: ORDER_1,
      kind: FiscalInvoiceKind.invoice,
      status: FiscalInvoiceStatus.requires_review,
      provider: "sistemas360",
      provider_environment: null,
      idempotency_key: `${BUSINESS_A}:${ORDER_1}:invoice`,
      retry_count: 0,
    };
    mocked(prisma.fiscal_invoice.findMany).mockResolvedValue([row]);
    mocked(prisma.fiscal_invoice.count).mockResolvedValue(0);

    // Primer ciclo: proveedor no disponible.
    mocked(resolveBillingProvider).mockResolvedValueOnce(null);
    mocked(prisma.fiscal_invoice.updateMany).mockResolvedValue({ count: 1 });
    mocked(prisma.fiscal_invoice.findUniqueOrThrow).mockResolvedValue(row);
    const first = await reconcilePendingInvoices(50);
    expect(first.providerUnavailable).toBe(1);

    // Segundo ciclo: se restableció la configuración — la MISMA fila se reconcilia (no se crea
    // ninguna fila nueva ni se llama a issueInvoice).
    const issueInvoice = vi.fn();
    const getInvoiceStatus = vi.fn().mockResolvedValue({
      status: "authorized",
      providerInvoiceId: "ext-1",
      voucherType: "B",
      comprobanteNumero: 1,
      cae: "71234567890123",
      caeVencimiento: "2027-01-01",
      pdfUrl: null,
      errorMessage: null,
      raw: {},
    });
    mocked(resolveBillingProvider).mockResolvedValueOnce(buildProvider({ issueInvoice, getInvoiceStatus }));
    mocked(prisma.fiscal_invoice.findUniqueOrThrow).mockResolvedValue({
      ...row,
      status: FiscalInvoiceStatus.authorized,
    });

    const second = await reconcilePendingInvoices(50);

    expect(issueInvoice).not.toHaveBeenCalled();
    expect(getInvoiceStatus).toHaveBeenCalledTimes(1);
    expect(second.reconciled).toBe(1);
    expect(prisma.fiscal_invoice.create).not.toHaveBeenCalled();
  });

  it("la idempotencyKey/referencia externa se mantiene idéntica entre un intento y su reintento posterior en el tiempo", async () => {
    mocked(isInvoicingAddonEnabled).mockResolvedValue(true);
    mocked(prisma.orders.findFirst).mockResolvedValue(baseOrder());
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig());

    // Primer intento: falla antes de enviar nada (error local) — queda en 'failed'.
    mocked(prisma.fiscal_invoice.findUnique).mockResolvedValueOnce(null);
    const createdRow = { id: "inv-1", business_id: BUSINESS_A, status: FiscalInvoiceStatus.processing };
    mocked(prisma.fiscal_invoice.create).mockResolvedValueOnce(createdRow);
    const issueInvoiceFail = vi.fn().mockRejectedValue(new Error("fallo de red simulado"));
    mocked(resolveBillingProvider).mockResolvedValue(buildProvider({ issueInvoice: issueInvoiceFail }));
    mocked(prisma.fiscal_invoice.updateMany).mockResolvedValue({ count: 1 });
    mocked(prisma.fiscal_invoice.findUniqueOrThrow).mockResolvedValueOnce({
      ...createdRow,
      status: FiscalInvoiceStatus.requires_review,
    });

    await requestInvoiceEmission(BUSINESS_A, ORDER_1, FiscalInvoiceKind.invoice);
    const firstKey = mocked(prisma.fiscal_invoice.create).mock.calls[0][0].data.idempotency_key;

    // "Más tarde" (otra invocación separada): la fila ya existe en requires_review — se reconcilia
    // con la MISMA referencia externa, nunca se crea una fila/clave nueva para el mismo pedido.
    mocked(prisma.fiscal_invoice.findUnique).mockResolvedValueOnce({
      ...createdRow,
      status: FiscalInvoiceStatus.requires_review,
      retry_count: 1,
    });
    const getInvoiceStatus = vi.fn().mockResolvedValue({
      status: "authorized",
      providerInvoiceId: "ext-1",
      voucherType: "B",
      comprobanteNumero: 1,
      cae: "71234567890123",
      caeVencimiento: "2027-01-01",
      pdfUrl: null,
      errorMessage: null,
      raw: {},
    });
    mocked(resolveBillingProvider).mockResolvedValue(buildProvider({ getInvoiceStatus }));

    await requestInvoiceEmission(BUSINESS_A, ORDER_1, FiscalInvoiceKind.invoice);

    expect(getInvoiceStatus).toHaveBeenCalledWith(firstKey);
    expect(prisma.fiscal_invoice.create).toHaveBeenCalledTimes(1); // nunca una segunda fila/clave.
  });

  it("recupera una emisión interrumpida después de persistir 'processing' y antes de recibir respuesta HTTP (el worker la toma igual)", async () => {
    // Simula: el proceso creó la fila ('processing') y murió antes de que `issueInvoice`
    // devolviera algo. El worker, en el siguiente ciclo, la toma igual — nunca llama a
    // `issueInvoice` de nuevo, solo consulta.
    const interrupted = {
      id: "inv-1",
      business_id: BUSINESS_A,
      order_id: ORDER_1,
      kind: FiscalInvoiceKind.invoice,
      status: FiscalInvoiceStatus.processing,
      provider: "sistemas360",
      provider_environment: null,
      idempotency_key: `${BUSINESS_A}:${ORDER_1}:invoice`,
      retry_count: 0,
    };
    mocked(prisma.fiscal_invoice.findMany).mockResolvedValue([interrupted]);
    mocked(prisma.fiscal_invoice.count).mockResolvedValue(0);

    const issueInvoice = vi.fn();
    const getInvoiceStatus = vi.fn().mockResolvedValue({
      status: "authorized",
      providerInvoiceId: "ext-1",
      voucherType: "B",
      comprobanteNumero: 1,
      cae: "71234567890123",
      caeVencimiento: "2027-01-01",
      pdfUrl: null,
      errorMessage: null,
      raw: {},
    });
    mocked(resolveBillingProvider).mockResolvedValue(buildProvider({ issueInvoice, getInvoiceStatus }));
    mocked(prisma.fiscal_invoice.updateMany).mockResolvedValue({ count: 1 });
    mocked(prisma.fiscal_invoice.findUniqueOrThrow).mockResolvedValue({
      ...interrupted,
      status: FiscalInvoiceStatus.authorized,
    });

    const result = await reconcilePendingInvoices(50);

    expect(issueInvoice).not.toHaveBeenCalled();
    expect(getInvoiceStatus).toHaveBeenCalledTimes(1);
    expect(result.reconciled).toBe(1);
  });

  it("un /reintentar que devuelve de nuevo 'pendiente_confirmacion' (vía getInvoiceStatus) no genera una emisión duplicada ni recursión", async () => {
    const row = {
      id: "inv-1",
      business_id: BUSINESS_A,
      order_id: ORDER_1,
      kind: FiscalInvoiceKind.invoice,
      status: FiscalInvoiceStatus.processing,
      provider: "sistemas360",
      provider_environment: null,
      idempotency_key: `${BUSINESS_A}:${ORDER_1}:invoice`,
      retry_count: 0,
    };
    mocked(prisma.fiscal_invoice.findMany).mockResolvedValue([row]);
    mocked(prisma.fiscal_invoice.count).mockResolvedValue(0);

    const issueInvoice = vi.fn();
    // El adaptador ya normaliza 'pendiente_confirmacion' (tras escalar a /reintentar) a
    // "processing" — sigue sin ser terminal, no hay nada que persistir como autorizado todavía.
    const getInvoiceStatus = vi.fn().mockResolvedValue({
      status: "processing",
      providerInvoiceId: "ext-1",
      voucherType: null,
      comprobanteNumero: null,
      cae: null,
      caeVencimiento: null,
      pdfUrl: null,
      errorMessage: null,
      raw: {},
    });
    mocked(resolveBillingProvider).mockResolvedValue(buildProvider({ issueInvoice, getInvoiceStatus }));
    mocked(prisma.fiscal_invoice.updateMany).mockResolvedValue({ count: 1 });
    mocked(prisma.fiscal_invoice.findUniqueOrThrow).mockResolvedValue({ ...row, status: FiscalInvoiceStatus.processing });

    const result = await reconcilePendingInvoices(50);

    expect(issueInvoice).not.toHaveBeenCalled();
    expect(getInvoiceStatus).toHaveBeenCalledTimes(1);
    expect(prisma.fiscal_invoice.create).not.toHaveBeenCalled();
    expect(result.reconciled).toBe(1);
  });
});

describe("listInvoices", () => {
  beforeEach(() => {
    mocked(prisma.fiscal_invoice.findMany).mockResolvedValue([]);
  });

  it("filtra por status cuando se indica", async () => {
    await listInvoices(BUSINESS_A, { status: FiscalInvoiceStatus.authorized });

    expect(prisma.fiscal_invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          business_id: BUSINESS_A,
          status: FiscalInvoiceStatus.authorized,
        }),
      }),
    );
  });

  it("filtra por período (dateFrom/dateTo en formato YYYY-MM-DD) usando created_at", async () => {
    await listInvoices(BUSINESS_A, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });

    const call = mocked(prisma.fiscal_invoice.findMany).mock.calls[0][0] as {
      where: { created_at?: { gte?: Date; lte?: Date } };
    };
    expect(call.where.created_at?.gte?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(call.where.created_at?.lte?.toISOString()).toBe("2026-01-31T23:59:59.999Z");
  });

  it("no agrega filtro de created_at si no se pasa dateFrom/dateTo", async () => {
    await listInvoices(BUSINESS_A, {});

    const call = mocked(prisma.fiscal_invoice.findMany).mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(call.where.created_at).toBeUndefined();
  });

  it("rechaza un dateFrom inválido con un error reconocible por el controller", async () => {
    await expect(listInvoices(BUSINESS_A, { dateFrom: "no-es-una-fecha" })).rejects.toThrow(
      "INVALID_DATE_FROM",
    );
  });

  it("rechaza un dateTo inválido con un error reconocible por el controller", async () => {
    await expect(listInvoices(BUSINESS_A, { dateTo: "no-es-una-fecha" })).rejects.toThrow(
      "INVALID_DATE_TO",
    );
  });
});
