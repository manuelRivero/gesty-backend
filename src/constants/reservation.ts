/** Reservas que ocupan la mesa para cálculo de disponibilidad */
export const RESERVATION_OCCUPYING_STATUSES = [
  "confirmed",
  "partial",
  "completed"
] as const;

export type ReservationOccupyingStatus =
  (typeof RESERVATION_OCCUPYING_STATUSES)[number];
