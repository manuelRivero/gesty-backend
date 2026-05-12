import { prisma } from '../lib/prisma';

export interface CoverageZoneRow {
  id: string;
  name: string;
  delivery_fee: string | null;
  min_order_amount: string | null;
  estimated_delivery_minutes: number | null;
  priority: number | null;
}

/**
 * Busca la zona de cobertura activa de mayor prioridad para un punto geográfico.
 */
export const findCoverageZoneForPoint = async (
  lat: number,
  lng: number,
  businessId: string
): Promise<CoverageZoneRow | null> => {
  const result = await prisma.$queryRaw<CoverageZoneRow[]>`
    SELECT
      id,
      name,
      delivery_fee,
      min_order_amount,
      estimated_delivery_minutes,
      priority
    FROM business_coverage_zone
    WHERE is_active = true
      AND business_id = ${businessId}::uuid
      AND ST_Intersects(
        coverage_area,
        ST_SetSRID(ST_MakePoint(${lng}::float8, ${lat}::float8), 4326)::geography
      )
    ORDER BY priority DESC
    LIMIT 1
  `;
  return result[0] ?? null;
};

/**
 * Re-valida la cobertura de una dirección guardada usando su location almacenada.
 * Si la dirección no tiene location, devuelve null (no se puede validar espacialmente).
 */
export const findCoverageZoneForAddress = async (
  addressId: string,
  businessId: string
): Promise<CoverageZoneRow | null> => {
  const result = await prisma.$queryRaw<CoverageZoneRow[]>`
    SELECT
      bcz.id,
      bcz.name,
      bcz.delivery_fee,
      bcz.min_order_amount,
      bcz.estimated_delivery_minutes,
      bcz.priority
    FROM business_coverage_zone bcz
    JOIN customer_address ca ON ca.id = ${addressId}::uuid
    WHERE bcz.is_active = true
      AND bcz.business_id = ${businessId}::uuid
      AND ca.location IS NOT NULL
      AND ST_Intersects(bcz.coverage_area, ca.location)
    ORDER BY bcz.priority DESC
    LIMIT 1
  `;
  return result[0] ?? null;
};
