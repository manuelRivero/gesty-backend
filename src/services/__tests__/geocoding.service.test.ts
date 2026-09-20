import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    geocoding_cache: {
      findUnique: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn()
    },
    $executeRaw: vi.fn()
  }
}));

vi.mock("../../config/env", () => ({
  env: {
    GEOCODING_PROVIDER: "google",
    GEOCODING_GOOGLE_API_KEY: "test-google-key",
    GOOGLE_MAPS_API_KEY: undefined,
    MAPBOX_ACCESS_TOKEN: undefined,
    GEOCODING_USER_AGENT: undefined
  }
}));

vi.mock("axios", () => ({
  default: {
    get: vi.fn()
  }
}));

import axios from "axios";
import { prisma } from "../../lib/prisma";
import {
  isValidCoordinates,
  reverseGeocode,
  reverseGeocodeFormatted,
  composeStreetAddress,
  parseHouseNumberFromDisplayName
} from "../geocoding.service";

const mockedGet = axios.get as unknown as ReturnType<typeof vi.fn>;
const mockedFind = prisma.geocoding_cache.findUnique as unknown as ReturnType<
  typeof vi.fn
>;
const mockedUpdate = prisma.geocoding_cache.update as unknown as ReturnType<
  typeof vi.fn
>;
const mockedUpsert = prisma.geocoding_cache.upsert as unknown as ReturnType<
  typeof vi.fn
>;
const mockedExecuteRaw = prisma.$executeRaw as unknown as ReturnType<
  typeof vi.fn
>;

describe("composeStreetAddress / parseHouseNumberFromDisplayName", () => {
  it("junta road + house_number", () => {
    expect(
      composeStreetAddress({ road: "Corrientes", houseNumber: "1234" })
    ).toBe("Corrientes 1234");
  });

  it("saca altura del display_name si falta house_number", () => {
    expect(
      composeStreetAddress({
        road: "Corrientes",
        houseNumber: null,
        displayName: "Corrientes 1850, Centro, Rosario, Santa Fe, Argentina"
      })
    ).toBe("Corrientes 1850");
  });

  it("saca altura cuando display_name empieza con número", () => {
    expect(
      parseHouseNumberFromDisplayName("1850, Corrientes, Rosario", "Corrientes")
    ).toBe("1850");
  });

  it("sin altura disponible deja solo la calle", () => {
    expect(
      composeStreetAddress({
        road: "Corrientes",
        houseNumber: null,
        displayName: "Corrientes, Centro, Rosario, Argentina"
      })
    ).toBe("Corrientes");
  });
});

describe("geocoding.service reverseGeocode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFind.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({});
    mockedUpsert.mockResolvedValue({});
    mockedExecuteRaw.mockResolvedValue(1);
  });

  it("isValidCoordinates rechaza fuera de rango", () => {
    expect(isValidCoordinates(-32.95, -60.66)).toBe(true);
    expect(isValidCoordinates(91, 0)).toBe(false);
    expect(isValidCoordinates(0, 181)).toBe(false);
    expect(isValidCoordinates(Number.NaN, 0)).toBe(false);
  });

  it("devuelve textos mapeados desde Google y escribe cache", async () => {
    mockedGet.mockResolvedValue({
      data: {
        status: "OK",
        results: [
          {
            formatted_address: "Mitre 1200, Centro, Rosario, Santa Fe",
            address_components: [
              { long_name: "1200", short_name: "1200", types: ["street_number"] },
              { long_name: "Mitre", short_name: "Mitre", types: ["route"] },
              {
                long_name: "Centro",
                short_name: "Centro",
                types: ["neighborhood", "political"]
              },
              {
                long_name: "Rosario",
                short_name: "Rosario",
                types: ["locality", "political"]
              },
              {
                long_name: "2000",
                short_name: "2000",
                types: ["postal_code"]
              }
            ],
            geometry: { location_type: "ROOFTOP" }
          }
        ]
      }
    });

    const result = await reverseGeocode(-32.95, -60.66);

    expect(result.streetAddress).toBe("Mitre 1200");
    expect(result.neighborhood).toBe("Centro");
    expect(result.city).toBe("Rosario");
    expect(result.formatted).toContain("Mitre");
    expect(result.provider).toBe("google");
    expect(result.confidence).toBe("high");
    expect(result.fromCache).toBe(false);
    expect(mockedUpsert).toHaveBeenCalledTimes(1);
    expect(mockedExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it("completa altura desde formatted_address si falta street_number", async () => {
    mockedGet.mockResolvedValue({
      data: {
        status: "OK",
        results: [
          {
            formatted_address: "Corrientes 1850, Centro, Rosario, Santa Fe",
            address_components: [
              {
                long_name: "Corrientes",
                short_name: "Corrientes",
                types: ["route"]
              },
              {
                long_name: "Rosario",
                short_name: "Rosario",
                types: ["locality", "political"]
              }
            ],
            geometry: { location_type: "GEOMETRIC_CENTER" }
          }
        ]
      }
    });

    const result = await reverseGeocode(-32.95, -60.66);
    expect(result.streetAddress).toBe("Corrientes 1850");
  });

  it("sirve desde cache sin llamar al proveedor", async () => {
    mockedFind.mockResolvedValue({
      street_address: "San Martín 500",
      neighborhood: "Centro",
      city: "Rosario",
      formatted_address: "San Martín 500, Centro, Rosario",
      latitude: new Prisma.Decimal("-32.95000000"),
      longitude: new Prisma.Decimal("-60.66000000"),
      data_source: "google",
      accuracy: "medium",
      expires_at: new Date(Date.now() + 86_400_000)
    });

    const result = await reverseGeocode(-32.95, -60.66);

    expect(result.streetAddress).toBe("San Martín 500");
    expect(result.fromCache).toBe(true);
    expect(result.provider).toBe("google");
    expect(mockedGet).not.toHaveBeenCalled();
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
  });

  it("sin resultado útil → nulls (no lanza)", async () => {
    mockedGet
      .mockResolvedValueOnce({
        data: { status: "ZERO_RESULTS", results: [] }
      })
      .mockResolvedValueOnce({
        data: { status: "ZERO_RESULTS", results: [] }
      });

    const result = await reverseGeocode(-32.95, -60.66);

    expect(result.streetAddress).toBeNull();
    expect(result.formatted).toBe("");
    expect(result.provider).toBe("google");
    expect(mockedUpsert).not.toHaveBeenCalled();
  });

  it("coords inválidas lanzan INVALID_COORDINATES", async () => {
    await expect(reverseGeocode(999, 0)).rejects.toThrow("INVALID_COORDINATES");
  });

  it("reverseGeocodeFormatted cae a Ubicación (lat, lng)", async () => {
    mockedGet
      .mockResolvedValueOnce({ data: { status: "ZERO_RESULTS", results: [] } })
      .mockResolvedValueOnce({ data: { status: "ZERO_RESULTS", results: [] } });

    const text = await reverseGeocodeFormatted(-32.95, -60.66);
    expect(text).toBe("Ubicación (-32.95, -60.66)");
  });
});
