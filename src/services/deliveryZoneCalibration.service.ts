/**
 * Calibración de tarifas planas vs PedidosYa Courier.
 *
 * ESTADO: experimental / dormida. PedidosYa no concedió acceso a la API aún.
 * Sin PEDIDOSYA_* en env el feature responde 503 y no afecta checkout ni delivery.
 * Se conserva el código por si el acceso llega; no usarla en producción hasta
 * validar login + estimates contra sandbox real.
 */

import { Prisma } from '@prisma/client';
import { env } from '../config/env';
import {
  estimateShipping,
  isPedidosYaCourierConfigured,
  pickCheapestOfferTotal,
} from '../integrations/pedidosya/courierClient';
import {
  PedidosYaApiError,
  PedidosYaNotConfiguredError,
  type LatLng,
} from '../integrations/pedidosya/types';
import { prisma } from '../lib/prisma';

export type CalibrationSampleKind = 'near' | 'mid' | 'far';

export type CalibrationSampleResult = {
  kind: CalibrationSampleKind;
  label: string;
  lat: number;
  lng: number;
  ok: boolean;
  price: number | null;
  distanceMeters: number | null;
  error: string | null;
};

export type ZoneCalibrationAction = 'increase' | 'keep' | 'optional_decrease';

export type ZoneCalibrationResult = {
  zoneId: string;
  zoneName: string;
  currentFee: number;
  pedidosYa: {
    min: number | null;
    max: number | null;
    avg: number | null;
    successfulSamples: number;
    failedSamples: number;
  };
  suggestedFee: number | null;
  safetyBufferPercent: number;
  action: ZoneCalibrationAction | 'insufficient_data';
  message: string;
  samples: CalibrationSampleResult[];
};

export type DeliveryZoneCalibrationReport = {
  available: true;
  disclaimer: string;
  safetyBufferPercent: number;
  origin: {
    lat: number;
    lng: number;
    address: string;
    city: string;
    businessName: string;
  };
  zones: ZoneCalibrationResult[];
  generatedAt: string;
};

type BusinessOriginRow = {
  name: string;
  latitude: number | null;
  longitude: number | null;
  street_address: string | null;
  whatsapp_phone_number: string | null;
};

type ZoneSampleRow = {
  id: string;
  name: string;
  delivery_fee: Prisma.Decimal | null;
  near_lat: number | null;
  near_lng: number | null;
  mid_lat: number | null;
  mid_lng: number | null;
  far_lat: number | null;
  far_lng: number | null;
};

const DISCLAIMER =
  'Estimación de referencia PedidosYa (cuenta de plataforma, modo test). ' +
  'No representa la factura de tu cuenta ni garantiza el precio del domingo en hora pico. ' +
  'Usala para decidir si tus tarifas planas cubren el costo dinámico con colchón.';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundMoney(value: number): number {
  return Math.ceil(value);
}

function stats(prices: number[]): { min: number; max: number; avg: number } {
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  return { min, max, avg };
}

/** Expuesto para tests unitarios (lógica pura, sin red). */
export function resolveAction(
  currentFee: number,
  suggestedFee: number
): ZoneCalibrationAction {
  // Tolera 1 unidad monetaria de ruido de redondeo.
  if (currentFee + 1 < suggestedFee) return 'increase';
  if (currentFee > suggestedFee * 1.25) return 'optional_decrease';
  return 'keep';
}

/** Expuesto para tests unitarios. */
export function actionMessage(
  action: ZoneCalibrationAction | 'insufficient_data',
  currentFee: number,
  suggestedFee: number | null
): string {
  switch (action) {
    case 'increase':
      return `Tu fee actual ($${currentFee}) no cubre el promedio PedidosYa + colchón. Sugerido: $${suggestedFee}.`;
    case 'keep':
      return `Tu fee actual ($${currentFee}) ya cubre el promedio PedidosYa con el colchón configurado.`;
    case 'optional_decrease':
      return `Tu fee actual ($${currentFee}) está bastante por encima del sugerido ($${suggestedFee}). Podés bajarlo si querés ser más competitivo.`;
    case 'insufficient_data':
      return 'No se pudo cotizar ningún punto de esta zona en PedidosYa.';
  }
}

async function loadBusinessOrigin(businessId: string): Promise<{
  lat: number;
  lng: number;
  address: string;
  city: string;
  businessName: string;
  phone: string;
}> {
  const rows = await prisma.$queryRaw<BusinessOriginRow[]>(Prisma.sql`
    SELECT name, latitude, longitude, street_address, whatsapp_phone_number
    FROM business
    WHERE id = ${businessId}
    LIMIT 1
  `);

  const business = rows[0];
  if (!business) {
    throw new Error('Negocio no encontrado');
  }

  if (business.latitude == null || business.longitude == null) {
    throw new Error(
      'El negocio no tiene latitud/longitud configuradas. Completá la ubicación del local antes de calibrar.'
    );
  }

  const city = env.PEDIDOSYA_DEFAULT_CITY || 'Buenos Aires';
  const address =
    business.street_address?.trim() ||
    env.PEDIDOSYA_DEFAULT_PICKUP_ADDRESS ||
    'Local';
  const phone =
    business.whatsapp_phone_number?.trim() ||
    env.PEDIDOSYA_DEFAULT_PHONE ||
    '+540000000000';

  return {
    lat: Number(business.latitude),
    lng: Number(business.longitude),
    address,
    city,
    businessName: business.name,
    phone,
  };
}

/**
 * Por zona activa: 3 puntos representativos derivados del polígono.
 * - near: punto del polígono más cercano al local
 * - mid: centroide
 * - far: vértice más lejano al local
 */
async function loadZonesWithSamplePoints(
  businessId: string,
  origin: LatLng
): Promise<ZoneSampleRow[]> {
  return prisma.$queryRaw<ZoneSampleRow[]>(Prisma.sql`
    WITH biz AS (
      SELECT ST_SetSRID(
        ST_MakePoint(${origin.lng}, ${origin.lat}),
        4326
      ) AS geom
    ),
    zones AS (
      SELECT
        z.id,
        z.name,
        z.delivery_fee,
        z.coverage_area::geometry AS geom
      FROM business_coverage_zone z
      WHERE z.business_id = ${businessId}
        AND z.is_active = true
    ),
    near_pts AS (
      SELECT
        z.id,
        ST_Y(ST_ClosestPoint(z.geom, biz.geom))::double precision AS near_lat,
        ST_X(ST_ClosestPoint(z.geom, biz.geom))::double precision AS near_lng
      FROM zones z
      CROSS JOIN biz
    ),
    mid_pts AS (
      SELECT
        z.id,
        ST_Y(ST_Centroid(z.geom))::double precision AS mid_lat,
        ST_X(ST_Centroid(z.geom))::double precision AS mid_lng
      FROM zones z
    ),
    far_pts AS (
      SELECT DISTINCT ON (z.id)
        z.id,
        ST_Y(pts.geom)::double precision AS far_lat,
        ST_X(pts.geom)::double precision AS far_lng
      FROM zones z
      CROSS JOIN biz
      CROSS JOIN LATERAL (
        SELECT (ST_DumpPoints(z.geom)).geom AS geom
      ) pts
      ORDER BY
        z.id,
        ST_Distance(pts.geom::geography, biz.geom::geography) DESC
    )
    SELECT
      z.id,
      z.name,
      z.delivery_fee,
      n.near_lat,
      n.near_lng,
      m.mid_lat,
      m.mid_lng,
      f.far_lat,
      f.far_lng
    FROM zones z
    JOIN near_pts n ON n.id = z.id
    JOIN mid_pts m ON m.id = z.id
    JOIN far_pts f ON f.id = z.id
    ORDER BY z.name ASC
  `);
}

function buildSamplesFromRow(
  row: ZoneSampleRow
): Array<{ kind: CalibrationSampleKind; label: string; point: LatLng }> {
  const out: Array<{
    kind: CalibrationSampleKind;
    label: string;
    point: LatLng;
  }> = [];

  if (row.near_lat != null && row.near_lng != null) {
    out.push({
      kind: 'near',
      label: 'Más cercano',
      point: { lat: row.near_lat, lng: row.near_lng },
    });
  }
  if (row.mid_lat != null && row.mid_lng != null) {
    out.push({
      kind: 'mid',
      label: 'Centro',
      point: { lat: row.mid_lat, lng: row.mid_lng },
    });
  }
  if (row.far_lat != null && row.far_lng != null) {
    out.push({
      kind: 'far',
      label: 'Más lejano',
      point: { lat: row.far_lat, lng: row.far_lng },
    });
  }

  return out;
}

async function quotePoint(params: {
  origin: Awaited<ReturnType<typeof loadBusinessOrigin>>;
  dropoff: LatLng;
  referenceId: string;
}): Promise<{ price: number | null; distanceMeters: number | null }> {
  const estimate = await estimateShipping({
    referenceId: params.referenceId,
    isTest: env.PEDIDOSYA_IS_TEST !== false,
    notificationMail: env.PEDIDOSYA_NOTIFICATION_EMAIL || undefined,
    items: [
      {
        type: 'STANDARD',
        value: Number(env.PEDIDOSYA_DEFAULT_ITEM_VALUE ?? 5000),
        description: 'Pedido food-service (calibración tarifas)',
        sku: 'CALIBRATION',
        quantity: 1,
        volume: 1,
        weight: 1,
      },
    ],
    waypoints: [
      {
        type: 'PICK_UP',
        addressStreet: params.origin.address,
        city: params.origin.city,
        latitude: params.origin.lat,
        longitude: params.origin.lng,
        phone: params.origin.phone,
        name: params.origin.businessName,
        instructions: 'Calibración de tarifas — no entregar',
      },
      {
        type: 'DROP_OFF',
        addressStreet: 'Punto de calibración',
        city: params.origin.city,
        latitude: params.dropoff.lat,
        longitude: params.dropoff.lng,
        phone: params.origin.phone,
        name: 'Cliente calibración',
        instructions: 'Calibración de tarifas — no entregar',
      },
    ],
  });

  return {
    price: pickCheapestOfferTotal(estimate),
    distanceMeters:
      typeof estimate.routes?.distance === 'number'
        ? estimate.routes.distance
        : null,
  };
}

export function getDeliveryZoneCalibrationStatus(): {
  configured: boolean;
  safetyBufferPercent: number;
  isTest: boolean;
} {
  return {
    configured: isPedidosYaCourierConfigured(),
    safetyBufferPercent: env.PEDIDOSYA_SAFETY_BUFFER_PERCENT ?? 15,
    isTest: env.PEDIDOSYA_IS_TEST !== false,
  };
}

/**
 * Contrasta el fee plano de cada zona activa del business contra cotizaciones
 * reales de PedidosYa Courier (cuenta SaaS en .env) y sugiere tarifa con colchón.
 */
export async function calibrateDeliveryZones(params: {
  businessId: string;
  safetyBufferPercent?: number;
}): Promise<DeliveryZoneCalibrationReport> {
  if (!isPedidosYaCourierConfigured()) {
    throw new PedidosYaNotConfiguredError();
  }

  const safetyBufferPercent =
    params.safetyBufferPercent ?? env.PEDIDOSYA_SAFETY_BUFFER_PERCENT ?? 15;
  if (safetyBufferPercent < 0 || safetyBufferPercent > 100) {
    throw new Error('safetyBufferPercent debe estar entre 0 y 100');
  }

  const origin = await loadBusinessOrigin(params.businessId);
  const zones = await loadZonesWithSamplePoints(params.businessId, {
    lat: origin.lat,
    lng: origin.lng,
  });

  if (zones.length === 0) {
    throw new Error(
      'No hay zonas de entrega activas para calibrar. Creá al menos una zona primero.'
    );
  }

  const delayMs = env.PEDIDOSYA_REQUEST_DELAY_MS ?? 500;
  const zoneResults: ZoneCalibrationResult[] = [];

  for (const zone of zones) {
    const currentFee = zone.delivery_fee ? Number(zone.delivery_fee) : 0;
    const sampleDefs = buildSamplesFromRow(zone);
    const samples: CalibrationSampleResult[] = [];

    for (const sample of sampleDefs) {
      // Delay entre requests para no gatillar rate limiting de PedidosYa.
      if (samples.length > 0 || zoneResults.length > 0) {
        await sleep(delayMs);
      }

      try {
        const quoted = await quotePoint({
          origin,
          dropoff: sample.point,
          referenceId: `cal-${params.businessId.slice(0, 8)}-${zone.id.slice(0, 8)}-${sample.kind}`,
        });

        samples.push({
          kind: sample.kind,
          label: sample.label,
          lat: sample.point.lat,
          lng: sample.point.lng,
          ok: quoted.price != null,
          price: quoted.price,
          distanceMeters: quoted.distanceMeters,
          error:
            quoted.price == null
              ? 'PedidosYa no devolvió ofertas para este punto (posible fuera de flota)'
              : null,
        });
      } catch (err) {
        const message =
          err instanceof PedidosYaApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Error desconocido cotizando PedidosYa';

        samples.push({
          kind: sample.kind,
          label: sample.label,
          lat: sample.point.lat,
          lng: sample.point.lng,
          ok: false,
          price: null,
          distanceMeters: null,
          error: message,
        });
      }
    }

    const prices = samples
      .map((s) => s.price)
      .filter((p): p is number => p != null);

    if (prices.length === 0) {
      zoneResults.push({
        zoneId: zone.id,
        zoneName: zone.name,
        currentFee,
        pedidosYa: {
          min: null,
          max: null,
          avg: null,
          successfulSamples: 0,
          failedSamples: samples.length,
        },
        suggestedFee: null,
        safetyBufferPercent,
        action: 'insufficient_data',
        message: actionMessage('insufficient_data', currentFee, null),
        samples,
      });
      continue;
    }

    const { min, max, avg } = stats(prices);
    const suggestedFee = roundMoney(avg * (1 + safetyBufferPercent / 100));
    const action = resolveAction(currentFee, suggestedFee);

    zoneResults.push({
      zoneId: zone.id,
      zoneName: zone.name,
      currentFee,
      pedidosYa: {
        min: roundMoney(min),
        max: roundMoney(max),
        avg: roundMoney(avg),
        successfulSamples: prices.length,
        failedSamples: samples.length - prices.length,
      },
      suggestedFee,
      safetyBufferPercent,
      action,
      message: actionMessage(action, currentFee, suggestedFee),
      samples,
    });
  }

  return {
    available: true,
    disclaimer: DISCLAIMER,
    safetyBufferPercent,
    origin: {
      lat: origin.lat,
      lng: origin.lng,
      address: origin.address,
      city: origin.city,
      businessName: origin.businessName,
    },
    zones: zoneResults,
    generatedAt: new Date().toISOString(),
  };
}

export { PedidosYaNotConfiguredError, PedidosYaApiError };
