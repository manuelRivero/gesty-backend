export type ReservationStep =
  | 'ASK_NAME'        // @deprecated — solo para shim de migración (estados viejos en DB)
  | 'ASK_DATE'
  | 'ASK_SLOT'
  | 'ASK_PARTY_SIZE'
  | 'ASK_ENVIRONMENT'
  | 'ASK_NAME_FINAL'  // nombre al final si !customer.name
  | 'CONFIRM';

export type ReservationState = {
  step: ReservationStep;
  date?: string;
  slotId?: string;
  time?: string;
  endTime?: string;
  partySize?: number;
  environmentId?: string;
  paused?: boolean;
};

export type FindTableInput = {
  businessId: string;
  date: string;
  startTime: string;
  endTime: string;
  partySize: number;
  environmentId?: string;
};

export type FindTableResult = {
  tableIds: string[] | null;
  reason?: string;
};

/** Horario de reserva (dominio; alineado con filas de `reservation_slot`). */
export type ReservationSlot = {
  id: string;
  start_time: string;
  end_time: string;
  is_active: boolean | null;
};

export type EnvironmentPreferenceRow = {
  id: string;
  name: string;
  is_outdoor: boolean;
};
