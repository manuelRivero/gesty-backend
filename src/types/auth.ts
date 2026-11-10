/** Alineado con `business_user.role` en BD (TEXT / CHECK), no enum en Prisma. */
export const BUSINESS_USER_ROLES = [
  "SUPER_ADMIN",
  "OWNER",
  "ADMIN",
  "STAFF",
  "DELIVERY",
  /// Mesas/comandas de salón (POS_TECHNICAL_DESIGN.md §4.F) — rol dedicado,
  /// ya no un stand-in de STAFF. Exclusivo: OWNER/ADMIN no operan table-tabs
  /// ni kitchen-tickets (decisión del negocio, no una limitación técnica).
  "MOZO"
] as const;
export type BusinessUserRole = (typeof BUSINESS_USER_ROLES)[number];

/** Roles que un OWNER/ADMIN puede asignar a una membresía del negocio. */
export const ASSIGNABLE_BUSINESS_USER_ROLES = [
  "OWNER",
  "ADMIN",
  "STAFF",
  "DELIVERY",
  "MOZO"
] as const;
export type AssignableBusinessUserRole =
  (typeof ASSIGNABLE_BUSINESS_USER_ROLES)[number];

export function isAssignableBusinessUserRole(
  role: string
): role is AssignableBusinessUserRole {
  return (ASSIGNABLE_BUSINESS_USER_ROLES as readonly string[]).includes(role);
}

export function parseBusinessUserRole(role: string): BusinessUserRole {
  if ((BUSINESS_USER_ROLES as readonly string[]).includes(role)) {
    return role as BusinessUserRole;
  }
  throw new Error("INVALID_MEMBERSHIP_ROLE");
}
