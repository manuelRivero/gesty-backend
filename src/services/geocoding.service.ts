/**
 * Reverse geocoding compartido (bot + storefront).
 *
 * Cobertura/fee sigue siendo `findCoverageZoneForPoint` (pin lat/lng).
 * Este servicio solo rellena textos legibles (calle, barrio, ciudad).
 *
 * Proveedor: `GEOCODING_PROVIDER` = google | mapbox | nominatim
 * (default: nominatim — encaja con Leaflet/OSM; sin API key).
 */

import { createHash } from "crypto";
import axios from "axios";
import { Prisma } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";

export type GeocodingProviderName = "google" | "mapbox" | "nominatim";

export type GeocodeConfidence = "high" | "medium" | "low";

export type ReverseGeocodeResult = {
  streetAddress: string | null;
  neighborhood: string | null;
  city: string | null;
  formatted: string;
  latitude: number;
  longitude: number;
  provider: GeocodingProviderName | "none";
  confidence: GeocodeConfidence | null;
  /** true si la respuesta salió de `geocoding_cache` */
  fromCache: boolean;
};

type ProviderPayload = {
  streetAddress: string | null;
  neighborhood: string | null;
  city: string | null;
  formatted: string;
  postalCode: string | null;
  confidence: GeocodeConfidence | null;
  provider: GeocodingProviderName;
};

const CACHE_PRECISION = 5; // ~1.1 m
const PROVIDER_TIMEOUT_MS = 8_000;

export function isValidCoordinates(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function roundCoord(n: number): number {
  const f = 10 ** CACHE_PRECISION;
  return Math.round(n * f) / f;
}

function reverseQueryKey(lat: number, lng: number): string {
  // v2: incluye altura cuando Nominatim la trae en display_name / zoom=18
  return `reverse:v2:${roundCoord(lat).toFixed(CACHE_PRECISION)},${roundCoord(lng).toFixed(CACHE_PRECISION)}`;
}

/**
 * Arma "Calle 1234". Si el proveedor no manda house_number (común en Nominatim
 * cuando el pin cae en la traza), intenta sacarlo del display_name.
 */
export function composeStreetAddress(params: {
  road: string | null;
  houseNumber: string | null;
  displayName?: string | null;
}): string | null {
  const road = params.road?.trim() || null;
  let houseNumber = params.houseNumber?.trim() || null;

  if (!houseNumber && params.displayName) {
    houseNumber = parseHouseNumberFromDisplayName(params.displayName, road);
  }

  if (road && houseNumber) return `${road} ${houseNumber}`;
  return road || houseNumber || null;
}

/** Extrae altura de display_name OSM/Nominatim (formatos AR frecuentes). */
export function parseHouseNumberFromDisplayName(
  displayName: string,
  road: string | null
): string | null {
  const name = displayName.trim();
  if (!name) return null;

  if (road) {
    const escaped = road.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const afterRoad = name.match(
      new RegExp(`${escaped}\\s+(\\d+[A-Za-z]?)\\b`, "i")
    );
    if (afterRoad?.[1]) return afterRoad[1];

    const beforeComma = name.match(
      new RegExp(`^(\\d+[A-Za-z]?)\\s*,\\s*${escaped}\\b`, "i")
    );
    if (beforeComma?.[1]) return beforeComma[1];
  }

  const streetThenNumber = name.match(/^([^,]+?)\s+(\d+[A-Za-z]?)\s*,/);
  if (streetThenNumber?.[2]) return streetThenNumber[2];

  const numberFirst = name.match(/^(\d+[A-Za-z]?)\s*,/);
  if (numberFirst?.[1]) return numberFirst[1];

  return null;
}

function hashQuery(queryText: string): string {
  return createHash("sha256").update(queryText).digest("hex");
}

function joinFormatted(parts: Array<string | null | undefined>): string {
  return parts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean)
    .join(", ");
}

function emptyResult(
  lat: number,
  lng: number,
  provider: GeocodingProviderName | "none" = "none"
): ReverseGeocodeResult {
  return {
    streetAddress: null,
    neighborhood: null,
    city: null,
    formatted: "",
    latitude: lat,
    longitude: lng,
    provider,
    confidence: null,
    fromCache: false
  };
}

export function resolveGeocodingProvider(): GeocodingProviderName {
  const explicit = env.GEOCODING_PROVIDER;
  if (explicit === "google" || explicit === "mapbox" || explicit === "nominatim") {
    return explicit;
  }
  return "nominatim";
}

function googleApiKey(): string | null {
  return (
    env.GEOCODING_GOOGLE_API_KEY?.trim() ||
    env.GOOGLE_MAPS_API_KEY?.trim() ||
    null
  );
}

function mapConfidenceFromGoogle(
  locationType: string | undefined
): GeocodeConfidence | null {
  switch (locationType) {
    case "ROOFTOP":
      return "high";
    case "RANGE_INTERPOLATED":
      return "medium";
    case "GEOMETRIC_CENTER":
    case "APPROXIMATE":
      return "low";
    default:
      return null;
  }
}

type GoogleAddressComponent = {
  long_name: string;
  short_name: string;
  types: string[];
};

function pickGoogleComponent(
  components: GoogleAddressComponent[],
  type: string
): string | null {
  const hit = components.find((c) => c.types.includes(type));
  return hit?.long_name?.trim() || null;
}

async function reverseViaGoogle(
  lat: number,
  lng: number
): Promise<ProviderPayload | null> {
  const key = googleApiKey();
  if (!key) return null;

  const { data } = await axios.get(
    "https://maps.googleapis.com/maps/api/geocode/json",
    {
      params: {
        latlng: `${lat},${lng}`,
        key,
        language: "es",
        result_type: "street_address|route|premise"
      },
      timeout: PROVIDER_TIMEOUT_MS
    }
  );

  if (data?.status !== "OK" || !Array.isArray(data.results) || data.results.length === 0) {
    // Reintento sin result_type (algunos puntos solo traen locality).
    const retry = await axios.get(
      "https://maps.googleapis.com/maps/api/geocode/json",
      {
        params: { latlng: `${lat},${lng}`, key, language: "es" },
        timeout: PROVIDER_TIMEOUT_MS
      }
    );
    if (
      retry.data?.status !== "OK" ||
      !Array.isArray(retry.data.results) ||
      retry.data.results.length === 0
    ) {
      return null;
    }
    return mapGoogleResult(retry.data.results[0]);
  }

  return mapGoogleResult(data.results[0]);
}

function mapGoogleResult(result: {
  formatted_address?: string;
  address_components?: GoogleAddressComponent[];
  geometry?: { location_type?: string };
}): ProviderPayload {
  const components = result.address_components ?? [];
  const route = pickGoogleComponent(components, "route");
  const streetNumber = pickGoogleComponent(components, "street_number");
  const formattedRaw =
    typeof result.formatted_address === "string"
      ? result.formatted_address.trim()
      : "";
  const streetAddress = composeStreetAddress({
    road: route,
    houseNumber: streetNumber,
    displayName: formattedRaw
  });

  const neighborhood =
    pickGoogleComponent(components, "neighborhood") ||
    pickGoogleComponent(components, "sublocality_level_1") ||
    pickGoogleComponent(components, "sublocality") ||
    null;

  const city =
    pickGoogleComponent(components, "locality") ||
    pickGoogleComponent(components, "administrative_area_level_2") ||
    null;

  const postalCode = pickGoogleComponent(components, "postal_code");
  const formatted =
    formattedRaw || joinFormatted([streetAddress, neighborhood, city]);

  return {
    streetAddress,
    neighborhood,
    city,
    formatted,
    postalCode,
    confidence: mapConfidenceFromGoogle(result.geometry?.location_type),
    provider: "google"
  };
}

async function reverseViaMapbox(
  lat: number,
  lng: number
): Promise<ProviderPayload | null> {
  const token = env.MAPBOX_ACCESS_TOKEN?.trim();
  if (!token) return null;

  const { data } = await axios.get(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json`,
    {
      params: {
        access_token: token,
        language: "es",
        types: "address,place,locality,neighborhood",
        limit: 1
      },
      timeout: PROVIDER_TIMEOUT_MS
    }
  );

  const feature = Array.isArray(data?.features) ? data.features[0] : null;
  if (!feature) return null;

  const props = feature.properties ?? {};
  const context: Array<{ id: string; text?: string }> = Array.isArray(
    feature.context
  )
    ? feature.context
    : [];

  const pickCtx = (prefix: string): string | null => {
    const hit = context.find((c) => typeof c.id === "string" && c.id.startsWith(prefix));
    return hit?.text?.trim() || null;
  };

  const streetName =
    typeof feature.text === "string" ? feature.text.trim() : null;
  const houseNumber =
    typeof props.address === "string"
      ? props.address.trim()
      : typeof feature.address === "string"
        ? feature.address.trim()
        : null;
  const placeName =
    typeof feature.place_name === "string" ? feature.place_name.trim() : "";
  const streetAddress = composeStreetAddress({
    road: streetName,
    houseNumber,
    displayName: placeName
  });

  const neighborhood = pickCtx("neighborhood") || pickCtx("locality");
  const city = pickCtx("place") || pickCtx("district") || pickCtx("region");
  const postalCode = pickCtx("postcode");
  const formatted =
    placeName || joinFormatted([streetAddress, neighborhood, city]);

  const relevance =
    typeof feature.relevance === "number" ? feature.relevance : null;
  const confidence: GeocodeConfidence | null =
    relevance == null
      ? null
      : relevance >= 0.8
        ? "high"
        : relevance >= 0.5
          ? "medium"
          : "low";

  return {
    streetAddress,
    neighborhood,
    city,
    formatted,
    postalCode,
    confidence,
    provider: "mapbox"
  };
}

async function reverseViaNominatim(
  lat: number,
  lng: number
): Promise<ProviderPayload | null> {
  const { data } = await axios.get(
    "https://nominatim.openstreetmap.org/reverse",
    {
      params: {
        lat,
        lon: lng,
        format: "jsonv2",
        addressdetails: 1,
        // Building-level cuando existe; sin esto suele devolver solo la traza.
        zoom: 18,
        "accept-language": "es"
      },
      timeout: PROVIDER_TIMEOUT_MS,
      headers: {
        "User-Agent":
          env.GEOCODING_USER_AGENT?.trim() ||
          "gesty-backend/1.0 (reverse-geocode; contact=ops@gesty.app)"
      }
    }
  );

  if (!data || data.error) return null;

  const addr = (data.address ?? {}) as Record<string, string | undefined>;
  const road =
    addr.road?.trim() ||
    addr.pedestrian?.trim() ||
    addr.residential?.trim() ||
    null;
  const houseNumber =
    addr.house_number?.trim() || addr.housenumber?.trim() || null;
  const displayName =
    typeof data.display_name === "string" ? data.display_name.trim() : "";
  const streetAddress = composeStreetAddress({
    road,
    houseNumber,
    displayName
  });

  const neighborhood =
    addr.neighbourhood?.trim() ||
    addr.suburb?.trim() ||
    addr.quarter?.trim() ||
    null;

  const city =
    addr.city?.trim() ||
    addr.town?.trim() ||
    addr.village?.trim() ||
    addr.municipality?.trim() ||
    null;

  const postalCode = addr.postcode?.trim() || null;
  const formatted =
    displayName || joinFormatted([streetAddress, neighborhood, city]);

  const importance =
    typeof data.importance === "number" ? data.importance : null;
  const confidence: GeocodeConfidence | null =
    importance == null
      ? "medium"
      : importance >= 0.5
        ? "high"
        : importance >= 0.3
          ? "medium"
          : "low";

  return {
    streetAddress,
    neighborhood,
    city,
    formatted,
    postalCode,
    confidence,
    provider: "nominatim"
  };
}

async function callProvider(
  lat: number,
  lng: number,
  provider: GeocodingProviderName
): Promise<ProviderPayload | null> {
  try {
    switch (provider) {
      case "google":
        return await reverseViaGoogle(lat, lng);
      case "mapbox":
        return await reverseViaMapbox(lat, lng);
      case "nominatim":
        return await reverseViaNominatim(lat, lng);
      default:
        return null;
    }
  } catch (err) {
    console.warn(
      `[geocoding] reverse via ${provider} failed:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

async function readCache(
  queryHash: string
): Promise<ReverseGeocodeResult | null> {
  const row = await prisma.geocoding_cache.findUnique({
    where: { query_hash: queryHash }
  });
  if (!row) return null;
  if (row.expires_at && row.expires_at.getTime() < Date.now()) {
    return null;
  }

  await prisma.geocoding_cache.update({
    where: { query_hash: queryHash },
    data: { hit_count: { increment: 1 } }
  });

  const streetAddress = row.street_address?.trim() || null;
  const neighborhood = row.neighborhood?.trim() || null;
  const city = row.city?.trim() || null;
  const formatted =
    row.formatted_address?.trim() ||
    joinFormatted([streetAddress, neighborhood, city]);

  const providerRaw = row.data_source?.trim();
  const provider: GeocodingProviderName | "none" =
    providerRaw === "google" ||
    providerRaw === "mapbox" ||
    providerRaw === "nominatim"
      ? providerRaw
      : "none";

  const accuracy = row.accuracy?.trim();
  const confidence: GeocodeConfidence | null =
    accuracy === "high" || accuracy === "medium" || accuracy === "low"
      ? accuracy
      : null;

  return {
    streetAddress,
    neighborhood,
    city,
    formatted,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    provider,
    confidence,
    fromCache: true
  };
}

async function writeCache(params: {
  queryHash: string;
  queryText: string;
  lat: number;
  lng: number;
  payload: ProviderPayload;
}): Promise<void> {
  const data = {
    query_text: params.queryText.slice(0, 500),
    formatted_address: params.payload.formatted.slice(0, 500) || null,
    street_address: params.payload.streetAddress?.slice(0, 255) || null,
    neighborhood: params.payload.neighborhood?.slice(0, 100) || null,
    city: params.payload.city?.slice(0, 100) || null,
    postal_code: params.payload.postalCode?.slice(0, 20) || null,
    latitude: new Prisma.Decimal(roundCoord(params.lat).toFixed(8)),
    longitude: new Prisma.Decimal(roundCoord(params.lng).toFixed(8)),
    accuracy: params.payload.confidence,
    data_source: params.payload.provider,
    expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    hit_count: 1
  };

  try {
    await prisma.geocoding_cache.upsert({
      where: { query_hash: params.queryHash },
      create: {
        query_hash: params.queryHash,
        ...data
      },
      update: {
        ...data,
        hit_count: { increment: 1 }
      }
    });

    await prisma.$executeRaw`
      UPDATE geocoding_cache
      SET location = ST_SetSRID(ST_MakePoint(${params.lng}::float8, ${params.lat}::float8), 4326)::geography
      WHERE query_hash = ${params.queryHash}
    `;
  } catch (err) {
    console.warn(
      "[geocoding] cache write failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Reverse geocode coords → textos. Preferencia de degradación:
 * cache → proveedor → 200 con nulls (nunca lanza por proveedor caído).
 */
export async function reverseGeocode(
  latitude: number,
  longitude: number
): Promise<ReverseGeocodeResult> {
  if (!isValidCoordinates(latitude, longitude)) {
    throw new Error("INVALID_COORDINATES");
  }

  const queryText = reverseQueryKey(latitude, longitude);
  const queryHash = hashQuery(queryText);

  const cached = await readCache(queryHash);
  if (cached) {
    return {
      ...cached,
      latitude,
      longitude
    };
  }

  const provider = resolveGeocodingProvider();
  const payload = await callProvider(latitude, longitude, provider);
  if (!payload || (!payload.streetAddress && !payload.formatted)) {
    return emptyResult(latitude, longitude, provider);
  }

  await writeCache({
    queryHash,
    queryText,
    lat: latitude,
    lng: longitude,
    payload
  });

  return {
    streetAddress: payload.streetAddress,
    neighborhood: payload.neighborhood,
    city: payload.city,
    formatted: payload.formatted,
    latitude,
    longitude,
    provider: payload.provider,
    confidence: payload.confidence,
    fromCache: false
  };
}

/**
 * Texto corto para el bot (AddressService): formatted o fallback coords.
 */
export async function reverseGeocodeFormatted(
  latitude: number,
  longitude: number
): Promise<string> {
  try {
    const result = await reverseGeocode(latitude, longitude);
    if (result.formatted) return result.formatted;
    if (result.streetAddress) {
      return joinFormatted([
        result.streetAddress,
        result.neighborhood,
        result.city
      ]);
    }
  } catch {
    // inválidas o error inesperado → fallback
  }
  return `Ubicación (${latitude}, ${longitude})`;
}
