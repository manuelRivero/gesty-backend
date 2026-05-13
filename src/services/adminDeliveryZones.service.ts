import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

type LngLat = [number, number];

export type GeoJsonPolygon = {
  type: "Polygon";
  coordinates: LngLat[][];
};

type DeliveryZoneRow = {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  delivery_fee: Prisma.Decimal | null;
  min_order_amount: Prisma.Decimal | null;
  estimated_delivery_minutes: number | null;
  schedule_override: Prisma.JsonValue | null;
  priority: number | null;
  is_active: boolean | null;
  created_at: Date | null;
  updated_at: Date | null;
  coverage_area_geojson: GeoJsonPolygon;
};

type BusinessMapCenterRow = {
  latitude: number | null;
  longitude: number | null;
};

type ZoneCenterRow = {
  lat: number;
  lng: number;
};

function mapZoneRow(row: DeliveryZoneRow) {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    description: row.description,
    deliveryFee: row.delivery_fee ? Number(row.delivery_fee) : null,
    minOrderAmount: row.min_order_amount ? Number(row.min_order_amount) : null,
    estimatedDeliveryMinutes: row.estimated_delivery_minutes,
    scheduleOverride: row.schedule_override,
    priority: row.priority ?? 0,
    isActive: row.is_active ?? true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    polygon: row.coverage_area_geojson
  };
}

const ZONE_SELECT_SQL = Prisma.sql`
  id,
  business_id,
  name,
  description,
  delivery_fee,
  min_order_amount,
  estimated_delivery_minutes,
  schedule_override,
  priority,
  is_active,
  created_at,
  updated_at,
  ST_AsGeoJSON(coverage_area::geometry)::json AS coverage_area_geojson
`;

async function getBusinessMapCenter(
  businessId: string
): Promise<{ lat: number; lng: number } | null> {
  const businessRows = await prisma.$queryRaw<BusinessMapCenterRow[]>(Prisma.sql`
    SELECT latitude, longitude
    FROM business
    WHERE id = ${businessId}
    LIMIT 1
  `);

  const business = businessRows[0];
  if (business?.latitude != null && business?.longitude != null) {
    return {
      lat: Number(business.latitude),
      lng: Number(business.longitude)
    };
  }

  const zoneCenterRows = await prisma.$queryRaw<ZoneCenterRow[]>(Prisma.sql`
    SELECT
      ST_Y(ST_Centroid(coverage_area::geometry))::double precision AS lat,
      ST_X(ST_Centroid(coverage_area::geometry))::double precision AS lng
    FROM business_coverage_zone
    WHERE business_id = ${businessId}
      AND is_active = true
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
  `);

  const zoneCenter = zoneCenterRows[0];
  if (!zoneCenter) {
    return null;
  }

  return { lat: zoneCenter.lat, lng: zoneCenter.lng };
}

export async function listAdminDeliveryZones(params: {
  businessId: string;
}) {
  const rows = await prisma.$queryRaw<DeliveryZoneRow[]>(Prisma.sql`
    SELECT ${ZONE_SELECT_SQL}
    FROM business_coverage_zone
    WHERE business_id = ${params.businessId}
    ORDER BY priority DESC, created_at ASC
  `);

  return {
    items: rows.map(mapZoneRow),
    total: rows.length,
    mapCenter: await getBusinessMapCenter(params.businessId)
  };
}

export async function getAdminDeliveryZoneById(params: {
  businessId: string;
  id: string;
}) {
  const rows = await prisma.$queryRaw<DeliveryZoneRow[]>(Prisma.sql`
    SELECT ${ZONE_SELECT_SQL}
    FROM business_coverage_zone
    WHERE business_id = ${params.businessId}
      AND id = ${params.id}
    LIMIT 1
  `);

  const row = rows[0];
  return row ? mapZoneRow(row) : null;
}

export async function createAdminDeliveryZone(params: {
  businessId: string;
  name: string;
  description?: string | null;
  polygon: GeoJsonPolygon;
  deliveryFee?: number | null;
  minOrderAmount?: number | null;
  estimatedDeliveryMinutes?: number | null;
  scheduleOverride?: Prisma.JsonValue | null;
  priority?: number;
  isActive?: boolean;
}) {
  const geoJson = JSON.stringify(params.polygon);

  const rows = await prisma.$queryRaw<DeliveryZoneRow[]>(Prisma.sql`
    INSERT INTO business_coverage_zone (
      business_id,
      name,
      description,
      coverage_area,
      delivery_fee,
      min_order_amount,
      estimated_delivery_minutes,
      schedule_override,
      priority,
      is_active
    )
    VALUES (
      ${params.businessId},
      ${params.name},
      ${params.description ?? null},
      ST_SetSRID(ST_GeomFromGeoJSON(${geoJson}), 4326)::geography,
      ${params.deliveryFee ?? 0},
      ${params.minOrderAmount ?? 0},
      ${params.estimatedDeliveryMinutes ?? null},
      ${params.scheduleOverride ?? null},
      ${params.priority ?? 0},
      ${params.isActive ?? true}
    )
    RETURNING ${ZONE_SELECT_SQL}
  `);

  return mapZoneRow(rows[0]);
}

export async function updateAdminDeliveryZone(params: {
  businessId: string;
  id: string;
  name?: string;
  description?: string | null;
  polygon?: GeoJsonPolygon;
  deliveryFee?: number | null;
  minOrderAmount?: number | null;
  estimatedDeliveryMinutes?: number | null;
  scheduleOverride?: Prisma.JsonValue | null;
  priority?: number;
  isActive?: boolean;
}) {
  const setClauses: Prisma.Sql[] = [];

  if (params.name !== undefined) {
    setClauses.push(Prisma.sql`name = ${params.name}`);
  }
  if (params.description !== undefined) {
    setClauses.push(Prisma.sql`description = ${params.description}`);
  }
  if (params.polygon !== undefined) {
    const geoJson = JSON.stringify(params.polygon);
    setClauses.push(
      Prisma.sql`coverage_area = ST_SetSRID(ST_GeomFromGeoJSON(${geoJson}), 4326)::geography`
    );
  }
  if (params.deliveryFee !== undefined) {
    setClauses.push(Prisma.sql`delivery_fee = ${params.deliveryFee}`);
  }
  if (params.minOrderAmount !== undefined) {
    setClauses.push(Prisma.sql`min_order_amount = ${params.minOrderAmount}`);
  }
  if (params.estimatedDeliveryMinutes !== undefined) {
    setClauses.push(
      Prisma.sql`estimated_delivery_minutes = ${params.estimatedDeliveryMinutes}`
    );
  }
  if (params.scheduleOverride !== undefined) {
    setClauses.push(Prisma.sql`schedule_override = ${params.scheduleOverride}`);
  }
  if (params.priority !== undefined) {
    setClauses.push(Prisma.sql`priority = ${params.priority}`);
  }
  if (params.isActive !== undefined) {
    setClauses.push(Prisma.sql`is_active = ${params.isActive}`);
  }

  if (setClauses.length === 0) {
    return getAdminDeliveryZoneById({
      businessId: params.businessId,
      id: params.id
    });
  }

  const rows = await prisma.$queryRaw<DeliveryZoneRow[]>(Prisma.sql`
    UPDATE business_coverage_zone
    SET ${Prisma.join(setClauses, ", ")},
        updated_at = NOW()
    WHERE business_id = ${params.businessId}
      AND id = ${params.id}
    RETURNING ${ZONE_SELECT_SQL}
  `);

  const row = rows[0];
  return row ? mapZoneRow(row) : null;
}

export async function deleteAdminDeliveryZone(params: {
  businessId: string;
  id: string;
}) {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    DELETE FROM business_coverage_zone
    WHERE business_id = ${params.businessId}
      AND id = ${params.id}
    RETURNING id
  `);

  return rows[0] ?? null;
}
