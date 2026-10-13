/**
 * Rubro gastronómico de un negocio, usado para armar el home/vitrina
 * global de Shopping (marketplace de restaurantes) con filtro por
 * categoría. Lista fija y cerrada: agregar una categoría nueva es un
 * cambio de código (no requiere migración de esquema).
 *
 * Única fuente de verdad: `GET /public/business-categories` expone
 * este catálogo para que el frontend no mantenga una copia de los
 * labels en código.
 */
export const BUSINESS_CATEGORY_OPTIONS = [
  { value: "BURGERS", label: "Hamburguesas" },
  { value: "PIZZA", label: "Pizza" },
  { value: "SUSHI", label: "Sushi" },
  { value: "HOME_MADE", label: "Comida casera" },
  { value: "EMPANADAS", label: "Empanadas" },
  { value: "HEALTHY", label: "Saludable" },
  { value: "OTHER", label: "Otra" }
] as const;

export const BUSINESS_CATEGORIES = BUSINESS_CATEGORY_OPTIONS.map(
  (opt) => opt.value
) as [BusinessCategory, ...BusinessCategory[]];

export type BusinessCategory =
  (typeof BUSINESS_CATEGORY_OPTIONS)[number]["value"];

export function isBusinessCategory(value: unknown): value is BusinessCategory {
  return (
    typeof value === "string" &&
    (BUSINESS_CATEGORIES as readonly string[]).includes(value)
  );
}
