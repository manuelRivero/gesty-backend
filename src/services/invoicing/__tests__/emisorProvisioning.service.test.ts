import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    fiscal_configuration: { updateMany: vi.fn(), findFirst: vi.fn() },
  },
}));

vi.mock("../../billing/billingLock", () => ({
  withBillingLock: vi.fn((_ns: string, _key: string, fn: () => unknown) => fn()),
}));

vi.mock("../fiscalConfiguration.service", () => ({
  getFiscalConfiguration: vi.fn(),
}));

vi.mock("../billingProviderFactory", () => ({
  resolveBillingProvider: vi.fn(),
}));

import { prisma } from "../../../lib/prisma";
import { getFiscalConfiguration } from "../fiscalConfiguration.service";
import { resolveBillingProvider } from "../billingProviderFactory";
import { ensureEmisorProvisioned } from "../emisorProvisioning.service";

function mocked(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

function baseFiscalConfig(overrides: Record<string, unknown> = {}) {
  return {
    business_id: "biz-1",
    cuit: "20123456786",
    razon_social: "Restaurante Test",
    condicion_iva: "RI",
    domicilio_fiscal: "Calle Falsa 123",
    punto_venta: 3,
    external_issuer_id: null,
    external_issuer_cuit: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ensureEmisorProvisioned", () => {
  it("no vuelve a asociar si el ID ya está probado para el CUIT vigente", async () => {
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig({
      external_issuer_id: "55",
      external_issuer_cuit: "20123456786",
    }));

    const result = await ensureEmisorProvisioned("biz-1");

    expect(result).toEqual({ provisioned: true, externalIssuerId: "55", status: "pending_validation", detail: "Ya asociado." });
    expect(resolveBillingProvider).not.toHaveBeenCalled();
  });

  it("crea la asociación una sola vez y persiste con CAS (where external_issuer_id: null)", async () => {
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig());
    const registerIssuer = vi.fn().mockResolvedValue({
      status: "pending_validation",
      externalIssuerId: "99",
      detail: "Emisor creado.",
    });
    mocked(resolveBillingProvider).mockResolvedValue({ registerIssuer });
    mocked(prisma.fiscal_configuration.findFirst).mockResolvedValue(null);
    mocked(prisma.fiscal_configuration.updateMany).mockResolvedValue({ count: 1 });

    const result = await ensureEmisorProvisioned("biz-1");

    expect(registerIssuer).toHaveBeenCalledTimes(1);
    expect(prisma.fiscal_configuration.findFirst).toHaveBeenCalledWith({
      where: { external_issuer_id: "99", business_id: { not: "biz-1" } },
      select: { id: true },
    });
    expect(prisma.fiscal_configuration.updateMany).toHaveBeenCalledWith({
      where: {
        business_id: "biz-1",
        cuit: "20123456786",
        external_issuer_id: null,
        external_issuer_cuit: null,
      },
      data: expect.objectContaining({
        external_issuer_id: "99",
        external_issuer_cuit: "20123456786",
      }),
    });
    expect(result).toEqual({ provisioned: true, externalIssuerId: "99", status: "pending_validation", detail: "Emisor creado." });
  });

  it("detiene el aprovisionamiento si el emisor encontrado ya pertenece a OTRO negocio de Gesty (sin crear duplicados remotos)", async () => {
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig());
    const registerIssuer = vi.fn().mockResolvedValue({
      status: "pending_validation",
      externalIssuerId: "77",
      detail: "Emisor existente en la cuenta, todavía no habilitado para producción.",
    });
    mocked(resolveBillingProvider).mockResolvedValue({ registerIssuer });
    mocked(prisma.fiscal_configuration.findFirst).mockResolvedValue({ id: "fc-other-business" });

    const result = await ensureEmisorProvisioned("biz-1");

    expect(result.status).toBe("conflict");
    expect(result.provisioned).toBe(false);
    expect(result.externalIssuerId).toBeNull();
    expect(prisma.fiscal_configuration.updateMany).not.toHaveBeenCalled();
  });

  it("no reporta conflicto cuando el emisor encontrado es del propio negocio", async () => {
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig());
    const registerIssuer = vi.fn().mockResolvedValue({
      status: "pending_validation",
      externalIssuerId: "99",
      detail: "Emisor creado.",
    });
    mocked(resolveBillingProvider).mockResolvedValue({ registerIssuer });
    // `findFirst` excluye explícitamente `business_id: "biz-1"` en el where — simulamos que el
    // propio negocio no aparece como "otro" dueño.
    mocked(prisma.fiscal_configuration.findFirst).mockResolvedValue(null);
    mocked(prisma.fiscal_configuration.updateMany).mockResolvedValue({ count: 1 });

    const result = await ensureEmisorProvisioned("biz-1");

    expect(result.status).toBe("pending_validation");
    expect(result.provisioned).toBe(true);
  });

  it("no reutiliza un ID asociado a otro CUIT: vuelve a resolver el CUIT vigente", async () => {
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig({
      cuit: "27234567891",
      external_issuer_id: "issuer-old",
      external_issuer_cuit: "20123456786",
    }));
    const registerIssuer = vi.fn().mockResolvedValue({
      status: "pending_validation",
      externalIssuerId: "issuer-new",
      detail: "Emisor encontrado.",
    });
    mocked(resolveBillingProvider).mockResolvedValue({ registerIssuer });
    mocked(prisma.fiscal_configuration.findFirst).mockResolvedValue(null);
    mocked(prisma.fiscal_configuration.updateMany).mockResolvedValue({ count: 1 });

    const result = await ensureEmisorProvisioned("biz-1");

    expect(registerIssuer).toHaveBeenCalledWith({
      issuer: expect.objectContaining({ cuit: "27234567891" }),
    });
    expect(prisma.fiscal_configuration.updateMany).toHaveBeenCalledWith({
      where: {
        business_id: "biz-1",
        cuit: "27234567891",
        external_issuer_id: "issuer-old",
        external_issuer_cuit: "20123456786",
      },
      data: expect.objectContaining({
        external_issuer_id: "issuer-new",
        external_issuer_cuit: "27234567891",
      }),
    });
    expect(result.provisioned).toBe(true);
    expect(result.externalIssuerId).toBe("issuer-new");
  });

  it("no persiste una asociación si falla el proveedor", async () => {
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig());
    const registerIssuer = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    mocked(resolveBillingProvider).mockResolvedValue({ registerIssuer });

    await expect(ensureEmisorProvisioned("biz-1")).rejects.toThrow("provider unavailable");

    expect(prisma.fiscal_configuration.updateMany).not.toHaveBeenCalled();
  });

  it("no provisiona si faltan datos fiscales (cuit)", async () => {
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig({ cuit: null }));

    const result = await ensureEmisorProvisioned("biz-3");

    expect(result).toEqual({ provisioned: false, externalIssuerId: null, status: "not_configured", detail: "Faltan datos fiscales del negocio." });
  });
});
