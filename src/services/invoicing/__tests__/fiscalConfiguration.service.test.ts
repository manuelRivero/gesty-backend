import { beforeEach, describe, expect, it, vi } from "vitest";

const lockState = vi.hoisted(() => ({
  tails: new Map<string, Promise<void>>(),
}));

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    fiscal_configuration: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
    },
    fiscal_invoice: { update: vi.fn(), updateMany: vi.fn() },
  },
}));

vi.mock("../../billing/billingLock", () => ({
  withBillingLock: vi.fn(async (namespace: string, key: string, operation: () => Promise<unknown>) => {
    const lockKey = `${namespace}:${key}`;
    const previous = lockState.tails.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    lockState.tails.set(lockKey, previous.then(() => current));
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }),
  BillingLockTimeoutError: class extends Error {},
  BillingLockUnavailableError: class extends Error {},
}));

vi.mock("../billingProviderFactory", () => ({
  resolveBillingProvider: vi.fn(),
  resolveCurrentEnvironment: vi.fn().mockResolvedValue("sandbox"),
}));

import { prisma } from "../../../lib/prisma";
import { resolveBillingProvider } from "../billingProviderFactory";
import { ensureEmisorProvisioned, provisionAfterFiscalSave } from "../emisorProvisioning.service";
import {
  checkFiscalConfigurationConnectivity,
  upsertFiscalConfiguration,
} from "../fiscalConfiguration.service";

function mocked(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  vi.clearAllMocks();
  lockState.tails.clear();
});

describe("fiscalConfiguration.service", () => {
  it("guarda los datos fiscales del negocio sin exigir credenciales centrales", async () => {
    mocked(prisma.fiscal_configuration.upsert).mockResolvedValue({
      business_id: "business-1",
      cuit: "20123456786",
      razon_social: "Restaurante Test",
      condicion_iva: "RI",
      domicilio_fiscal: "Calle 123",
      punto_venta: null,
      auto_issue_online: true,
      auto_issue_cash: false,
    });
    mocked(prisma.fiscal_configuration.findUnique).mockResolvedValue(null);

    await upsertFiscalConfiguration("business-1", {
      cuit: "20123456786",
      razonSocial: "Restaurante Test",
      condicionIva: "RI",
      domicilioFiscal: "Calle 123",
      autoIssueOnline: true,
      autoIssueCash: false,
    });

    const [args] = mocked(prisma.fiscal_configuration.upsert).mock.calls[0];
    expect(args.create).not.toHaveProperty("provider");
    expect(args.create).not.toHaveProperty("credentials");
    expect(args.create.punto_venta).toBeNull();
    expect(resolveBillingProvider).not.toHaveBeenCalled();
  });

  it("preserva la asociación si el CUIT solo cambia de formato", async () => {
    const current = {
      business_id: "business-1",
      cuit: "20-12345678-6",
      external_issuer_id: "issuer-1",
      external_issuer_cuit: "20123456786",
      punto_venta: 4,
      validated_at: new Date("2026-01-01T00:00:00.000Z"),
      status: "validated",
    };
    mocked(prisma.fiscal_configuration.findUnique).mockResolvedValue(current);
    mocked(prisma.fiscal_configuration.upsert).mockResolvedValue(current);

    await upsertFiscalConfiguration("business-1", {
      cuit: "20123456786",
      razonSocial: "Restaurante Test",
      condicionIva: "RI",
      domicilioFiscal: "Calle 123",
      autoIssueOnline: true,
      autoIssueCash: false,
    });

    const [args] = mocked(prisma.fiscal_configuration.upsert).mock.calls[0];
    expect(args.update).not.toHaveProperty("external_issuer_id");
    expect(args.update).not.toHaveProperty("external_issuer_cuit");
    expect(args.update).not.toHaveProperty("punto_venta");
    expect(args.update).not.toHaveProperty("validated_at");
    expect(args.update).not.toHaveProperty("status");
  });

  it("invalida la asociación y sus datos vinculados al cambiar realmente el CUIT", async () => {
    mocked(prisma.fiscal_configuration.findUnique).mockResolvedValue({
      business_id: "business-1",
      cuit: "20123456786",
      external_issuer_id: "issuer-1",
      external_issuer_cuit: "20123456786",
      punto_venta: 4,
      validated_at: new Date("2026-01-01T00:00:00.000Z"),
      status: "validated",
    });
    mocked(prisma.fiscal_configuration.upsert).mockResolvedValue({ business_id: "business-1" });

    await upsertFiscalConfiguration("business-1", {
      cuit: "27234567891",
      razonSocial: "Restaurante Test",
      condicionIva: "RI",
      domicilioFiscal: "Calle 123",
      autoIssueOnline: true,
      autoIssueCash: false,
    });

    const [args] = mocked(prisma.fiscal_configuration.upsert).mock.calls[0];
    expect(args.update).toMatchObject({
      external_issuer_id: null,
      external_issuer_cuit: null,
      punto_venta: null,
      validated_at: null,
      status: "pending_validation",
    });
    expect(prisma.fiscal_invoice.update).not.toHaveBeenCalled();
    expect(prisma.fiscal_invoice.updateMany).not.toHaveBeenCalled();
  });

  it("serializa un cambio de CUIT concurrente con el aprovisionamiento", async () => {
    let current = {
      business_id: "business-1",
      cuit: "20123456786",
      razon_social: "Restaurante Test",
      condicion_iva: "RI",
      domicilio_fiscal: "Calle 123",
      external_issuer_id: null as string | null,
      external_issuer_cuit: null as string | null,
      punto_venta: null as number | null,
      validated_at: null as Date | null,
      auto_issue_online: true,
      auto_issue_cash: false,
      status: "pending_validation",
    };
    mocked(prisma.fiscal_configuration.findUnique).mockImplementation(async () => current);
    mocked(prisma.fiscal_configuration.upsert).mockImplementation(async ({ create, update }) => {
      current = { ...current, ...(create ?? {}), ...(update ?? {}) } as typeof current;
      return current;
    });
    mocked(prisma.fiscal_configuration.updateMany).mockImplementation(async ({ where, data }) => {
      const matches =
        current.business_id === where.business_id &&
        current.cuit === where.cuit &&
        current.external_issuer_id === where.external_issuer_id &&
        current.external_issuer_cuit === where.external_issuer_cuit;
      if (matches) current = { ...current, ...data } as typeof current;
      return { count: matches ? 1 : 0 };
    });
    mocked(prisma.fiscal_configuration.findFirst).mockResolvedValue(null);

    let finishRegistration!: () => void;
    const registrationPaused = new Promise<void>((resolve) => {
      finishRegistration = resolve;
    });
    const registerIssuer = vi.fn(async () => {
      await registrationPaused;
      return {
        status: "pending_validation" as const,
        externalIssuerId: "issuer-old-cuit",
        detail: "Emisor encontrado.",
      };
    });
    mocked(resolveBillingProvider).mockResolvedValue({ registerIssuer });

    const provisioning = ensureEmisorProvisioned("business-1");
    await vi.waitFor(() => expect(registerIssuer).toHaveBeenCalledTimes(1));
    const configUpdate = upsertFiscalConfiguration("business-1", {
      cuit: "27234567891",
      razonSocial: "Restaurante Test",
      condicionIva: "RI",
      domicilioFiscal: "Calle 123",
      autoIssueOnline: true,
      autoIssueCash: false,
    });
    finishRegistration();

    await provisioning;
    await configUpdate;

    expect(current).toMatchObject({
      cuit: "27234567891",
      external_issuer_id: null,
      external_issuer_cuit: null,
      punto_venta: null,
      validated_at: null,
      status: "pending_validation",
    });
  });

  it("dos aprovisionamientos concurrentes registran y persisten una sola asociación", async () => {
    let current = {
      business_id: "business-1",
      cuit: "20123456786",
      razon_social: "Restaurante Test",
      condicion_iva: "RI",
      domicilio_fiscal: "Calle 123",
      external_issuer_id: null as string | null,
      external_issuer_cuit: null as string | null,
    };
    mocked(prisma.fiscal_configuration.findUnique).mockImplementation(async () => current);
    mocked(prisma.fiscal_configuration.findFirst).mockResolvedValue(null);
    mocked(prisma.fiscal_configuration.updateMany).mockImplementation(async ({ where, data }) => {
      const matches =
        current.business_id === where.business_id &&
        current.cuit === where.cuit &&
        current.external_issuer_id === where.external_issuer_id &&
        current.external_issuer_cuit === where.external_issuer_cuit;
      if (matches) current = { ...current, ...data } as typeof current;
      return { count: matches ? 1 : 0 };
    });
    const registerIssuer = vi.fn().mockResolvedValue({
      status: "pending_validation",
      externalIssuerId: "issuer-1",
      detail: "Emisor encontrado.",
    });
    mocked(resolveBillingProvider).mockResolvedValue({ registerIssuer });

    const results = await Promise.all([
      ensureEmisorProvisioned("business-1"),
      ensureEmisorProvisioned("business-1"),
    ]);

    expect(registerIssuer).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.provisioned)).toBe(true);
    expect(current).toMatchObject({
      external_issuer_id: "issuer-1",
      external_issuer_cuit: "20123456786",
    });
  });

  it("expone un error claro cuando falta la cuenta central activa de Sistemas 360", async () => {
    mocked(resolveBillingProvider).mockResolvedValue(null);

    const result = await checkFiscalConfigurationConnectivity("business-1");

    expect(result).toEqual({
      credentialsShapeValid: false,
      credentialErrors: ["No hay una cuenta central activa de Sistemas 360 con token configurado."],
      issuerStatus: null,
    });
  });

  /**
   * `upsertFiscalConfiguration` y `ensureEmisorProvisioned`/`provisionAfterFiscalSave` usan el
   * MISMO namespace de advisory lock (`fiscalConfigurationLock.ts`). El mock de `withBillingLock`
   * de este archivo serializa adquisiciones del mismo `namespace:key` encadenando promesas: si el
   * guardado llamara al aprovisionamiento DESDE DENTRO de su propio callback (lock anidado), la
   * segunda adquisición esperaría indefinidamente a que la primera se liberara — y la primera
   * nunca se libera porque está esperando a la segunda. Este test falla por timeout si eso ocurre;
   * si resuelve, confirma que son dos adquisiciones secuenciales, no anidadas.
   */
  it("guardar y luego aprovisionar (orquestación del PUT) no anida el lock — no hay deadlock", async () => {
    let current: Record<string, unknown> | null = null;
    mocked(prisma.fiscal_configuration.findUnique).mockImplementation(async () => current);
    mocked(prisma.fiscal_configuration.upsert).mockImplementation(async ({ create, update }) => {
      current = { ...(current ?? {}), ...(create ?? {}), ...(update ?? {}) };
      return current;
    });
    mocked(prisma.fiscal_configuration.findFirst).mockResolvedValue(null);
    mocked(prisma.fiscal_configuration.updateMany).mockImplementation(async ({ data }) => {
      current = { ...(current ?? {}), ...data };
      return { count: 1 };
    });
    const registerIssuer = vi.fn().mockResolvedValue({
      status: "pending_validation",
      externalIssuerId: "99",
      detail: "Emisor creado.",
    });
    mocked(resolveBillingProvider).mockResolvedValue({ registerIssuer });

    await upsertFiscalConfiguration("business-1", {
      cuit: "20123456786",
      razonSocial: "Restaurante Test",
      condicionIva: "RI",
      domicilioFiscal: "Calle 123",
      autoIssueOnline: true,
      autoIssueCash: false,
    });
    // Si lo anterior no hubiera liberado su lock (llamada anidada), esto nunca resolvería.
    const summary = await provisionAfterFiscalSave("business-1");

    expect(summary.outcome).toBe("provisioned");
    expect(registerIssuer).toHaveBeenCalledTimes(1);
  });
});
