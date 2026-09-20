import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../../services/geocoding.service", () => ({
  isValidCoordinates: vi.fn(),
  reverseGeocode: vi.fn()
}));

vi.mock("../../services/publicStorefront.service", () => ({
  resolveActivePublicBusiness: vi.fn()
}));

import {
  isValidCoordinates,
  reverseGeocode
} from "../../services/geocoding.service";
import { resolveActivePublicBusiness } from "../../services/publicStorefront.service";
import { reverseGeocodeStorefront } from "../publicGeocoding.controller";

const mockedValid = isValidCoordinates as unknown as ReturnType<typeof vi.fn>;
const mockedReverse = reverseGeocode as unknown as ReturnType<typeof vi.fn>;
const mockedBusiness = resolveActivePublicBusiness as unknown as ReturnType<
  typeof vi.fn
>;

function mockRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis()
  };
  return res as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

describe("reverseGeocodeStorefront controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedValid.mockReturnValue(true);
    mockedBusiness.mockResolvedValue({ id: "biz-1", slug: "sabroson" });
    mockedReverse.mockResolvedValue({
      streetAddress: "Mitre 1200",
      neighborhood: "Centro",
      city: "Rosario",
      formatted: "Mitre 1200, Centro, Rosario",
      latitude: -32.95,
      longitude: -60.66,
      provider: "google",
      confidence: "high",
      fromCache: false
    });
  });

  it("200 con campos cuando el local está activo", async () => {
    const req = {
      params: { slug: "sabroson" },
      body: { latitude: -32.95, longitude: -60.66 }
    } as unknown as Request;
    const res = mockRes();

    await reverseGeocodeStorefront(req, res);

    expect(res.json).toHaveBeenCalledWith({
      streetAddress: "Mitre 1200",
      neighborhood: "Centro",
      city: "Rosario",
      formatted: "Mitre 1200, Centro, Rosario",
      latitude: -32.95,
      longitude: -60.66,
      provider: "google",
      confidence: "high"
    });
  });

  it("400 INVALID_COORDINATES", async () => {
    mockedValid.mockReturnValue(false);
    const req = {
      params: { slug: "sabroson" },
      body: { latitude: 999, longitude: 0 }
    } as unknown as Request;
    const res = mockRes();

    await reverseGeocodeStorefront(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "INVALID_COORDINATES" })
    );
  });

  it("404 LOCAL_UNAVAILABLE", async () => {
    mockedBusiness.mockResolvedValue(null);
    const req = {
      params: { slug: "ghost" },
      body: { latitude: -32.95, longitude: -60.66 }
    } as unknown as Request;
    const res = mockRes();

    await reverseGeocodeStorefront(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "LOCAL_UNAVAILABLE" })
    );
  });

  it("200 con nulls si no hay resultado útil", async () => {
    mockedReverse.mockResolvedValue({
      streetAddress: null,
      neighborhood: null,
      city: null,
      formatted: "",
      latitude: -32.95,
      longitude: -60.66,
      provider: "none",
      confidence: null,
      fromCache: false
    });
    const req = {
      params: { slug: "sabroson" },
      body: { latitude: -32.95, longitude: -60.66 }
    } as unknown as Request;
    const res = mockRes();

    await reverseGeocodeStorefront(req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      streetAddress: null,
      neighborhood: null,
      city: null,
      formatted: "",
      latitude: -32.95,
      longitude: -60.66,
      provider: null,
      confidence: null
    });
  });
});
