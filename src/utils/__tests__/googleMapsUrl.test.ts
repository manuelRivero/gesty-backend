import { describe, expect, it } from "vitest";
import { buildGoogleMapsUrl } from "../googleMapsUrl";

describe("buildGoogleMapsUrl", () => {
  it("prioriza nombre y dirección sobre coordenadas", () => {
    const url = buildGoogleMapsUrl({
      name: "Picado Fino.",
      streetAddress: "San Martín 1234, Rosario",
      latitude: -32.9520757,
      longitude: -60.6695097
    });

    expect(url).toBe(
      "https://www.google.com/maps/search/?api=1&query=Picado%20Fino.%2C%20San%20Mart%C3%ADn%201234%2C%20Rosario"
    );
  });

  it("usa coordenadas solo cuando no hay texto de ubicación", () => {
    const url = buildGoogleMapsUrl({
      latitude: -32.9520757,
      longitude: -60.6695097
    });

    expect(url).toBe(
      "https://www.google.com/maps/search/?api=1&query=-32.9520757,-60.6695097"
    );
  });

  it("devuelve null si no hay datos de ubicación", () => {
    expect(buildGoogleMapsUrl({})).toBeNull();
  });
});
