/** Alineado con `business_user.role` en BD (TEXT / CHECK), no enum en Prisma. */
export const BUSINESS_USER_ROLES = [
  "SUPER_ADMIN",
  "OWNER",
  "ADMIN",
  "STAFF",
  "DELIVERY"
] as const;
export type BusinessUserRole = (typeof BUSINESS_USER_ROLES)[number];

export function parseBusinessUserRole(role: string): BusinessUserRole {
  if ((BUSINESS_USER_ROLES as readonly string[]).includes(role)) {
    return role as BusinessUserRole;
  }
  throw new Error("INVALID_MEMBERSHIP_ROLE");
}
