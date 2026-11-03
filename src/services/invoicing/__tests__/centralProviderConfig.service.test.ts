import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    invoicing_central_provider_config: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    fiscal_invoice: {
      count: vi.fn().mockResolvedValue(0),
    },
  },
}));

vi.mock("../../payment/crypto", () => ({
  encryptToken: vi.fn((v: string) => `enc(${v})`),
  decryptToken: vi.fn((v: string) => v.replace(/^enc\(/, "").replace(/\)$/, "")),
}));

vi.mock("../providers/sistemas360Client", () => ({
  sistemas360HealthArca: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
}));

vi.mock("../providers/sistemas360Adapter", () => ({
  sistemas360ValidateToken: vi.fn(),
}));

import { prisma } from "../../../lib/prisma";
import { sistemas360ValidateToken } from "../providers/sistemas360Adapter";
import {
  CentralProviderActivationBlockedError,
  CentralProviderEnvironmentChangeBlockedError,
  getCentralProviderConfigSafe,
  setCentralProviderActive,
  setCentralProviderEnvironment,
  setCentralProviderToken,
  validateCentralProviderConnectivity,
} from "../centralProviderConfig.service";

function mocked(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    provider: "sistemas360",
    active_environment: "sandbox",
    sandbox_token_encrypted: "enc(secret-token-value)",
    production_token_encrypted: null,
    is_active: false,
    status: "pending_validation",
    last_validated_at: null,
    last_validation_detail: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("centralProviderConfig.service", () => {
  it("getCentralProviderConfigSafe nunca incluye el token, ni cifrado ni en texto plano", async () => {
    mocked(prisma.invoicing_central_provider_config.findUnique).mockResolvedValue(baseRow());

    const safe = await getCentralProviderConfigSafe("sistemas360");

    expect(safe).not.toHaveProperty("sandbox_token_encrypted");
    expect(safe).not.toHaveProperty("production_token_encrypted");
    expect(JSON.stringify(safe)).not.toContain("secret-token-value");
    expect(safe?.hasSandboxToken).toBe(true);
    expect(safe?.hasProductionToken).toBe(false);
  });

  it("setCentralProviderToken cifra el token antes de guardarlo", async () => {
    mocked(prisma.invoicing_central_provider_config.upsert).mockResolvedValue(baseRow());

    await setCentralProviderToken({ provider: "sistemas360", environment: "sandbox", token: "plain-secret" });

    const call = mocked(prisma.invoicing_central_provider_config.upsert).mock.calls[0][0];
    expect(call.create.sandbox_token_encrypted).toBe("enc(plain-secret)");
    expect(JSON.stringify(call)).not.toContain("plain-secret\"");
  });

  it("setCentralProviderActive activa la única cuenta de Sistemas 360", async () => {
    mocked(prisma.invoicing_central_provider_config.findUnique).mockResolvedValue(baseRow());
    mocked(prisma.invoicing_central_provider_config.update).mockResolvedValue(baseRow({ is_active: true }));

    await setCentralProviderActive("sistemas360", true);

    expect(prisma.invoicing_central_provider_config.update).toHaveBeenCalledWith({
      where: { provider: "sistemas360" },
      data: expect.objectContaining({ is_active: true }),
    });
  });

  it("validateCentralProviderConnectivity nunca propaga el token al resultado", async () => {
    mocked(sistemas360ValidateToken).mockResolvedValue({ ok: true, detail: "Token válido." });
    mocked(prisma.invoicing_central_provider_config.findUnique).mockResolvedValue(
      baseRow({ is_active: true })
    );
    mocked(prisma.invoicing_central_provider_config.update).mockResolvedValue(baseRow({ status: "validated" }));

    const { validateCentralProviderConnectivity } = await import("../centralProviderConfig.service");
    await validateCentralProviderConnectivity("sistemas360");

    const call = mocked(prisma.invoicing_central_provider_config.update).mock.calls[0][0];
    expect(JSON.stringify(call)).not.toContain("secret-token-value");
  });

  describe("setCentralProviderEnvironment — aislamiento del entorno de emisión", () => {
    it("permite el cambio cuando no hay comprobantes pendientes", async () => {
      mocked(prisma.fiscal_invoice.count).mockResolvedValue(0);
      mocked(prisma.invoicing_central_provider_config.update).mockResolvedValue(
        baseRow({ active_environment: "production" })
      );

      const result = await setCentralProviderEnvironment("sistemas360", "production");

      expect(result.activeEnvironment).toBe("production");
    });

    it("rechaza el cambio si hay comprobantes processing/requires_review, sin modificar nada", async () => {
      mocked(prisma.fiscal_invoice.count).mockResolvedValue(3);

      await expect(setCentralProviderEnvironment("sistemas360", "production")).rejects.toBeInstanceOf(
        CentralProviderEnvironmentChangeBlockedError
      );
      expect(prisma.invoicing_central_provider_config.update).not.toHaveBeenCalled();
    });
  });

  describe("setCentralProviderActive — activación de producción sin validación", () => {
    it("rechaza activar producción sin token de producción configurado", async () => {
      mocked(prisma.invoicing_central_provider_config.findUnique).mockResolvedValue(
        baseRow({ active_environment: "production", production_token_encrypted: null })
      );

      await expect(setCentralProviderActive("sistemas360", true)).rejects.toBeInstanceOf(
        CentralProviderActivationBlockedError
      );
      expect(prisma.invoicing_central_provider_config.update).not.toHaveBeenCalled();
    });

    it("rechaza activar producción con token configurado pero NUNCA validado", async () => {
      mocked(prisma.invoicing_central_provider_config.findUnique).mockResolvedValue(
        baseRow({
          active_environment: "production",
          production_token_encrypted: "enc(prod-token)",
          status: "pending_validation",
          last_validated_environment: null,
        })
      );

      await expect(setCentralProviderActive("sistemas360", true)).rejects.toBeInstanceOf(
        CentralProviderActivationBlockedError
      );
    });

    it("rechaza activar producción si la última validación exitosa fue de sandbox, no de producción", async () => {
      mocked(prisma.invoicing_central_provider_config.findUnique).mockResolvedValue(
        baseRow({
          active_environment: "production",
          production_token_encrypted: "enc(prod-token)",
          status: "validated",
          last_validated_environment: "sandbox",
        })
      );

      await expect(setCentralProviderActive("sistemas360", true)).rejects.toBeInstanceOf(
        CentralProviderActivationBlockedError
      );
    });

    it("permite activar producción con token configurado y validado para ESE entorno", async () => {
      mocked(prisma.invoicing_central_provider_config.findUnique).mockResolvedValue(
        baseRow({
          active_environment: "production",
          production_token_encrypted: "enc(prod-token)",
          status: "validated",
          last_validated_environment: "production",
        })
      );
      mocked(prisma.invoicing_central_provider_config.update).mockResolvedValue(
        baseRow({ active_environment: "production", is_active: true })
      );

      const result = await setCentralProviderActive("sistemas360", true);

      expect(result.isActive).toBe(true);
    });

    it("un token modificado DESPUÉS de validarse ya no habilita la activación (status vuelve a pending_validation al guardar)", async () => {
      // `setCentralProviderToken` ya resetea `status` a pending_validation en cada escritura —
      // se simula ese efecto para demostrar que la activación lo respeta.
      mocked(prisma.invoicing_central_provider_config.upsert).mockResolvedValue(
        baseRow({
          active_environment: "production",
          production_token_encrypted: "enc(nuevo-token)",
          status: "pending_validation",
          last_validated_environment: "production", // huella vieja, pero `status` ya no es "validated"
        })
      );
      await setCentralProviderToken({ provider: "sistemas360", environment: "production", token: "nuevo-token" });

      mocked(prisma.invoicing_central_provider_config.findUnique).mockResolvedValue(
        baseRow({
          active_environment: "production",
          production_token_encrypted: "enc(nuevo-token)",
          status: "pending_validation",
          last_validated_environment: "production",
        })
      );

      await expect(setCentralProviderActive("sistemas360", true)).rejects.toBeInstanceOf(
        CentralProviderActivationBlockedError
      );
    });

    it("sandbox puede activarse sin validar (condición más permisiva, a propósito)", async () => {
      mocked(prisma.invoicing_central_provider_config.findUnique).mockResolvedValue(
        baseRow({ active_environment: "sandbox", status: "not_configured" })
      );
      mocked(prisma.invoicing_central_provider_config.update).mockResolvedValue(
        baseRow({ active_environment: "sandbox", is_active: true })
      );

      const result = await setCentralProviderActive("sistemas360", true);

      expect(result.isActive).toBe(true);
    });
  });

  describe("validateCentralProviderConnectivity — huella de entorno validado", () => {
    it("registra last_validated_environment solo cuando la validación es exitosa", async () => {
      mocked(sistemas360ValidateToken).mockResolvedValue({ ok: true, detail: "Token de cuenta válido." });
      mocked(prisma.invoicing_central_provider_config.findUnique).mockResolvedValue(
        baseRow({ is_active: true, active_environment: "production", production_token_encrypted: "enc(prod-token)" })
      );
      mocked(prisma.invoicing_central_provider_config.update).mockResolvedValue(baseRow({ status: "validated" }));

      await validateCentralProviderConnectivity("sistemas360");

      expect(prisma.invoicing_central_provider_config.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ last_validated_environment: "production" }) })
      );
    });

    it("no registra ningún entorno como validado si la validación falla", async () => {
      mocked(sistemas360ValidateToken).mockResolvedValue({
        ok: false,
        detail: "El token responde, pero no tiene permisos de cuenta para administrar emisores.",
      });
      mocked(prisma.invoicing_central_provider_config.findUnique).mockResolvedValue(
        baseRow({ is_active: true, active_environment: "production", production_token_encrypted: "enc(prod-token)" })
      );
      mocked(prisma.invoicing_central_provider_config.update).mockResolvedValue(baseRow({ status: "rejected" }));

      await validateCentralProviderConnectivity("sistemas360");

      expect(prisma.invoicing_central_provider_config.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ last_validated_environment: null }) })
      );
    });
  });
});
