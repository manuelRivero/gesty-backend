/** Reservas que ocupan la mesa para cálculo de disponibilidad */
export const RESERVATION_OCCUPYING_STATUSES = [
  "confirmed",
  "partial",
  "completed"
] as const;

export type ReservationOccupyingStatus =
  (typeof RESERVATION_OCCUPYING_STATUSES)[number];

/**
 * Horizonte de reservas: cuántos días hacia adelante se puede reservar.
 * Lo usa el gate de `save_reservation_date` para rechazar fechas absurdas
 * ("para Navidad" resuelto al año equivocado, un año tipeado de más).
 */
export const RESERVATION_MAX_DAYS_AHEAD = 365;
