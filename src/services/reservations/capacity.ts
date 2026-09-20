/**
 * Capacidad combinable del negocio para reservas (D7/R-G).
 * Compartida por la tool `save_reservation_party_size` y el tipable §3.11
 * de party size en el nodo.
 */

import { findActiveTablesByBusinessAndEnvironment } from '../../repositories/reservation.repository';

/** Suma de capacidades de mesas activas. `0` = sin mesas / sin tope usable. */
export async function getMaxCombinablePartySize(businessId: string): Promise<number> {
  const tables = await findActiveTablesByBusinessAndEnvironment(businessId);
  return tables.reduce((sum, t) => sum + t.capacity, 0);
}
