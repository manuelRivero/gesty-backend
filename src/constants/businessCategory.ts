/**
 * Rubro gastronómico de un negocio, usado para armar el home/vitrina
 * global de Shopping (marketplace de restaurantes) con filtro por
 * categoría. Lista fija y cerrada: agregar una categoría nueva es un
 * cambio de código (no requiere migración de esquema).
 */
export const BUSINESS_CATEGORIES = [
  "BURGERS",
  "PIZZA",
  "SUSHI",
  "HOME_MADE",
  "EMPANADAS",
  "HEALTHY",
  "OTHER"
] as const;

export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];

export function isBusinessCategory(value: unknown): value is BusinessCategory {
  return (
    typeof value === "string" &&
    (BUSINESS_CATEGORIES as readonly string[]).includes(value)
  );
}
