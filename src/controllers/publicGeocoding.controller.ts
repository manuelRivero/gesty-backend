import type { Request, Response } from "express";
import { z } from "zod";
import {
  isValidCoordinates,
  reverseGeocode
} from "../services/geocoding.service";
import { resolveActivePublicBusiness } from "../services/publicStorefront.service";

const slugParamSchema = z.object({
  slug: z.string().trim().min(1).max(120)
});

const reverseGeocodeBodySchema = z.object({
  latitude: z.number(),
  longitude: z.number()
});

/**
 * POST /api/public/businesses/:slug/reverse-geocode
 * Autocompleta calle/barrio/ciudad desde el pin. No afecta cobertura.
 */
export async function reverseGeocodeStorefront(req: Request, res: Response) {
  const parsedParams = slugParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "slug inválido" });
  }

  const parsedBody = reverseGeocodeBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: "Datos inválidos",
      code: "INVALID_BODY",
      details: parsedBody.error.flatten()
    });
  }

  const { latitude, longitude } = parsedBody.data;
  if (!isValidCoordinates(latitude, longitude)) {
    return res.status(400).json({
      error: "Coordenadas inválidas",
      code: "INVALID_COORDINATES"
    });
  }

  const business = await resolveActivePublicBusiness(parsedParams.data.slug);
  if (!business) {
    return res.status(404).json({
      error: "Local no disponible",
      code: "LOCAL_UNAVAILABLE"
    });
  }

  // Preferencia: 200 + nulls si el proveedor no trae nada útil (front pide tipeo).
  const result = await reverseGeocode(latitude, longitude);

  return res.json({
    streetAddress: result.streetAddress,
    neighborhood: result.neighborhood,
    city: result.city,
    formatted: result.formatted,
    latitude: result.latitude,
    longitude: result.longitude,
    provider: result.provider === "none" ? null : result.provider,
    confidence: result.confidence
  });
}
