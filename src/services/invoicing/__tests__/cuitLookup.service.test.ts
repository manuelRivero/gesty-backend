import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../billingProviderFactory", () => ({
  resolveBillingProvider: vi.fn(),
}));

import { resolveBillingProvider } from "../billingProviderFactory";
import { InvalidCuitError, lookupCuit, NoCentralProviderError } from "../cuitLookup.service";

function mocked(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("lookupCuit", () => {
  it("rechaza un CUIT con formato/dígito verificador inválido sin consultar al proveedor", async () => {
    await expect(lookupCuit("business-1", "123")).rejects.toBeInstanceOf(InvalidCuitError);
    expect(resolveBillingProvider).not.toHaveBeenCalled();
  });

  it("lanza NoCentralProviderError si no hay token central activo", async () => {
    mocked(resolveBillingProvider).mockResolvedValue(null);

    await expect(lookupCuit("business-1", "20123456786")).rejects.toBeInstanceOf(NoCentralProviderError);
  });

  it("delega en el provider.lookupCuit y no crea ni lista emisores (es de solo lectura)", async () => {
    const providerLookupCuit = vi.fn().mockResolvedValue({
      cuit: "20123456786",
      razonSocial: "Restaurante Test",
      condicionIva: "RI",
      condicionIvaRaw: "Responsable Inscripto",
      domicilioFiscal: "Calle Falsa 123",
    });
    mocked(resolveBillingProvider).mockResolvedValue({ lookupCuit: providerLookupCuit });

    const result = await lookupCuit("business-1", "20-12345678-6");

    expect(resolveBillingProvider).toHaveBeenCalledWith("business-1");
    expect(providerLookupCuit).toHaveBeenCalledWith("20-12345678-6");
    expect(result.razonSocial).toBe("Restaurante Test");
  });
});
