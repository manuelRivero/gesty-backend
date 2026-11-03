import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    fiscal_configuration: { findUnique: vi.fn() },
  },
}));

vi.mock("../centralProviderConfig.service", () => ({
  getActiveCentralToken: vi.fn(),
  getCentralTokenForEnvironment: vi.fn(),
}));

import { prisma } from "../../../lib/prisma";
import {
  getActiveCentralToken,
  getCentralTokenForEnvironment,
} from "../centralProviderConfig.service";
import {
  resolveBillingProvider,
  resolveCurrentEnvironment,
} from "../billingProviderFactory";
import { Sistemas360Adapter } from "../providers/sistemas360Adapter";

function mocked(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("billingProviderFactory", () => {
  it("no resuelve un proveedor si falta una cuenta central activa con token", async () => {
    mocked(getActiveCentralToken).mockResolvedValue(null);

    expect(await resolveBillingProvider("biz-1")).toBeNull();
    expect(prisma.fiscal_configuration.findUnique).not.toHaveBeenCalled();
  });

  it("resuelve Sistemas 360 con el emisor asociado al negocio", async () => {
    mocked(getActiveCentralToken).mockResolvedValue({
      token: "central-token",
      environment: "sandbox",
    });
    mocked(prisma.fiscal_configuration.findUnique).mockResolvedValue({
      external_issuer_id: "100",
    });

    const provider = await resolveBillingProvider("biz-1");

    expect(provider).toBeInstanceOf(Sistemas360Adapter);
    expect(prisma.fiscal_configuration.findUnique).toHaveBeenCalledWith({
      where: { business_id: "biz-1" },
      select: { external_issuer_id: true },
    });
  });

  it("resuelve las consultas de reconciliación con el entorno original", async () => {
    mocked(getCentralTokenForEnvironment).mockResolvedValue({
      token: "sandbox-token",
      environment: "sandbox",
    });
    mocked(prisma.fiscal_configuration.findUnique).mockResolvedValue({
      external_issuer_id: "100",
    });

    await resolveBillingProvider("biz-1", { environment: "sandbox" });

    expect(getCentralTokenForEnvironment).toHaveBeenCalledWith("sistemas360", "sandbox");
    expect(getActiveCentralToken).not.toHaveBeenCalled();
  });

  it("captura el entorno activo de Sistemas 360 para una emisión nueva", async () => {
    mocked(getActiveCentralToken).mockResolvedValue({
      token: "central-token",
      environment: "production",
    });

    expect(await resolveCurrentEnvironment()).toBe("production");
    expect(getActiveCentralToken).toHaveBeenCalledWith("sistemas360");
  });
});
