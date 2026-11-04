import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";

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
  resolveCurrentEnvironment: vi.fn().mockResolvedValue("sandbox"),
}));

import { prisma } from "../../../lib/prisma";
import { getFiscalConfiguration } from "../fiscalConfiguration.service";
import { resolveBillingProvider, resolveCurrentEnvironment } from "../billingProviderFactory";
import { ensureEmisorProvisioned } from "../emisorProvisioning.service";

function mocked(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

function currentEnvironment(environment: "sandbox" | "production") {
  mocked(resolveCurrentEnvironment).mockResolvedValue(environment);
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
    external_issuer_environment: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked(resolveCurrentEnvironment).mockResolvedValue("sandbox");
});

describe("ensureEmisorProvisioned", () => {
  it("no vuelve a asociar si el ID ya está probado para el CUIT vigente", async () => {
    currentEnvironment("sandbox");
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig({
      external_issuer_id: "55",
      external_issuer_cuit: "20123456786",
      external_issuer_environment: "sandbox",
    }));

    const result = await ensureEmisorProvisioned("biz-1");

    expect(result).toEqual({ provisioned: true, externalIssuerId: "55", status: "pending_validation", detail: "Ya asociado." });
    expect(resolveBillingProvider).not.toHaveBeenCalled();
  });

  it("vuelve a resolver la asociación cuando cambia el entorno activo, aunque coincida el CUIT", async () => {
    currentEnvironment("production");
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig({
      external_issuer_id: "55",
      external_issuer_cuit: "20123456786",
      external_issuer_environment: "sandbox",
    }));
    const registerIssuer = vi.fn().mockResolvedValue({
      status: "pending_validation",
      externalIssuerId: "55",
      detail: "Emisor encontrado.",
    });
    mocked(resolveBillingProvider).mockResolvedValue({ registerIssuer });
    mocked(prisma.fiscal_configuration.findFirst).mockResolvedValue(null);
    mocked(prisma.fiscal_configuration.updateMany).mockResolvedValue({ count: 1 });

    const result = await ensureEmisorProvisioned("biz-1");

    expect(resolveBillingProvider).toHaveBeenCalledWith("biz-1", { environment: "production" });
    expect(prisma.fiscal_configuration.findFirst).toHaveBeenCalledWith({
      where: {
        external_issuer_id: "55",
        business_id: { not: "biz-1" },
        OR: [
          { external_issuer_environment: "production" },
          { external_issuer_environment: null },
        ],
      },
      select: { id: true },
    });
    expect(prisma.fiscal_configuration.updateMany).toHaveBeenCalledWith({
      where: {
        business_id: "biz-1",
        cuit: "20123456786",
        external_issuer_id: "55",
        external_issuer_cuit: "20123456786",
        external_issuer_environment: "sandbox",
      },
      data: expect.objectContaining({ external_issuer_environment: "production" }),
    });
    expect(result.provisioned).toBe(true);
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
      where: {
        external_issuer_id: "99",
        business_id: { not: "biz-1" },
        OR: [
          { external_issuer_environment: "sandbox" },
          { external_issuer_environment: null },
        ],
      },
      select: { id: true },
    });
    expect(prisma.fiscal_configuration.updateMany).toHaveBeenCalledWith({
      where: {
        business_id: "biz-1",
        cuit: "20123456786",
        external_issuer_id: null,
        external_issuer_cuit: null,
        external_issuer_environment: null,
      },
      data: expect.objectContaining({
        external_issuer_id: "99",
        external_issuer_cuit: "20123456786",
        external_issuer_environment: "sandbox",
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
      external_issuer_environment: null,
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
        external_issuer_environment: null,
      },
      data: expect.objectContaining({
        external_issuer_id: "issuer-new",
        external_issuer_cuit: "27234567891",
        external_issuer_environment: "sandbox",
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

  it("convierte en conflicto un P2002 cuyo target es el nombre del índice fiscal actual", async () => {
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig());
    const registerIssuer = vi.fn().mockResolvedValue({
      status: "pending_validation",
      externalIssuerId: "99",
      detail: "Emisor encontrado.",
    });
    mocked(resolveBillingProvider).mockResolvedValue({ registerIssuer });
    mocked(prisma.fiscal_configuration.findFirst).mockResolvedValue(null);
    mocked(prisma.fiscal_configuration.updateMany).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: "unique_fiscal_configuration_issuer_environment_id" },
      })
    );

    const result = await ensureEmisorProvisioned("biz-1");

    expect(result).toMatchObject({
      provisioned: false,
      externalIssuerId: null,
      status: "conflict",
    });
  });

  it("propaga P2002 de una restricción que no es de asociación fiscal", async () => {
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig());
    const registerIssuer = vi.fn().mockResolvedValue({
      status: "pending_validation",
      externalIssuerId: "99",
      detail: "Emisor encontrado.",
    });
    mocked(resolveBillingProvider).mockResolvedValue({ registerIssuer });
    mocked(prisma.fiscal_configuration.findFirst).mockResolvedValue(null);
    mocked(prisma.fiscal_configuration.updateMany).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: "some_other_unique_constraint" },
      })
    );

    await expect(ensureEmisorProvisioned("biz-1")).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("no provisiona si faltan datos fiscales (cuit)", async () => {
    mocked(getFiscalConfiguration).mockResolvedValue(baseFiscalConfig({ cuit: null }));

    const result = await ensureEmisorProvisioned("biz-3");

    expect(result).toEqual({ provisioned: false, externalIssuerId: null, status: "not_configured", detail: "Faltan datos fiscales del negocio." });
  });
});

describe("índices de unicidad fiscal", () => {
  const migration = readFileSync(
    "prisma/migrations/20261103002200_unique_fiscal_external_issuer/migration.sql",
    "utf8"
  );

  it("rechaza el mismo ID dentro del mismo entorno", () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX unique_fiscal_configuration_issuer_environment_id\s+ON public\.fiscal_configuration \(external_issuer_environment, external_issuer_id\)\s+WHERE external_issuer_environment IS NOT NULL\s+AND external_issuer_id IS NOT NULL/
    );
  });

  it("permite el mismo ID en sandbox y producción", () => {
    expect(migration).toMatch(
      /ON public\.fiscal_configuration \(external_issuer_environment, external_issuer_id\)/
    );
    expect(migration).not.toMatch(
      /CREATE UNIQUE INDEX unique_fiscal_configuration_external_issuer_id\s+ON public\.fiscal_configuration \(external_issuer_id\)/
    );
  });

  it("rechaza el mismo ID repetido con entorno NULL", () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX unique_fiscal_configuration_issuer_id_without_environment\s+ON public\.fiscal_configuration \(external_issuer_id\)\s+WHERE external_issuer_environment IS NULL\s+AND external_issuer_id IS NOT NULL/
    );
  });

  it("permite IDs distintos con entorno NULL", () => {
    expect(migration).toMatch(
      /unique_fiscal_configuration_issuer_id_without_environment\s+ON public\.fiscal_configuration \(external_issuer_id\)/
    );
  });

  it("impide colisiones ambiguas entre un entorno NULL y uno conocido", () => {
    expect(migration).toMatch(
      /unique_fiscal_configuration_issuer_id_except_production\s+ON public\.fiscal_configuration \(external_issuer_id\)\s+WHERE external_issuer_id IS NOT NULL\s+AND \(external_issuer_environment IS NULL OR external_issuer_environment <> 'production'\)/
    );
    expect(migration).toMatch(
      /unique_fiscal_configuration_issuer_id_except_sandbox\s+ON public\.fiscal_configuration \(external_issuer_id\)\s+WHERE external_issuer_id IS NOT NULL\s+AND \(external_issuer_environment IS NULL OR external_issuer_environment <> 'sandbox'\)/
    );
  });
});
