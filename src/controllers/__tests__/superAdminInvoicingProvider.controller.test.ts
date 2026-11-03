import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../../services/invoicing/centralProviderConfig.service", () => ({
  SISTEMAS360_PROVIDER: "sistemas360",
  CentralProviderActivationBlockedError: class extends Error {},
  CentralProviderEnvironmentChangeBlockedError: class extends Error {},
  getCentralProviderConfigSafe: vi.fn(),
  setCentralProviderActive: vi.fn(),
  setCentralProviderEnvironment: vi.fn(),
  setCentralProviderToken: vi.fn(),
  validateCentralProviderConnectivity: vi.fn(),
}));

vi.mock("../../services/invoicing/providers/sistemas360Client", () => ({
  sistemas360HealthArca: vi.fn(),
}));

import {
  getArcaHealthHandler,
  getCentralProviderConfigHandler,
  postValidateCentralProviderHandler,
  putCentralProviderActiveHandler,
  putCentralProviderEnvironmentHandler,
  putCentralProviderTokenHandler,
} from "../superAdminInvoicingProvider.controller";
import {
  getCentralProviderConfigSafe,
  setCentralProviderActive,
  setCentralProviderEnvironment,
  setCentralProviderToken,
  validateCentralProviderConnectivity,
} from "../../services/invoicing/centralProviderConfig.service";
import { sistemas360HealthArca } from "../../services/invoicing/providers/sistemas360Client";

function mocked(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

function makeRequest(): Request {
  return {
    params: { provider: "not-sistemas360" },
    body: { environment: "sandbox", token: "token", isActive: true },
  } as unknown as Request;
}

function makeResponse() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & typeof res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SUPER_ADMIN central billing provider routes", () => {
  it("rechaza proveedores distintos de Sistemas 360 antes de acceder a la cuenta", async () => {
    const handlers = [
      getCentralProviderConfigHandler,
      putCentralProviderTokenHandler,
      putCentralProviderEnvironmentHandler,
      putCentralProviderActiveHandler,
      postValidateCentralProviderHandler,
      getArcaHealthHandler,
    ];

    for (const handler of handlers) {
      const res = makeResponse();
      await handler(makeRequest(), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: "Proveedor de facturación no encontrado." });
    }

    expect(getCentralProviderConfigSafe).not.toHaveBeenCalled();
    expect(setCentralProviderToken).not.toHaveBeenCalled();
    expect(setCentralProviderEnvironment).not.toHaveBeenCalled();
    expect(setCentralProviderActive).not.toHaveBeenCalled();
    expect(validateCentralProviderConnectivity).not.toHaveBeenCalled();
    expect(sistemas360HealthArca).not.toHaveBeenCalled();
  });
});
