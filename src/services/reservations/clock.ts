/**
 * Reloj único del flujo de reservas.
 *
 * Todo "ahora" del flujo (gate de fecha en las tools, ledger del agente,
 * filtros de disponibilidad, wizard legacy) sale de acá. Antes cada archivo
 * hacía su propio `new Date()`: el gate de `save_reservation_date` decidía
 * qué es "pasado" con un reloj, y el `[ESTADO DE LA RESERVA]` le decía al
 * modelo qué día es hoy con otro. Con un solo origen, mover el flujo a la
 * zona horaria del negocio es cambiar `reservationNow()` y nada más.
 *
 * También vive acá el formato `DD/MM/AAAA` y el nombre del día en español,
 * porque el gate y el ledger tienen que coincidir carácter por carácter: el
 * modelo lee el día que el ledger imprime y el gate lo verifica.
 */

export const DAY_NAMES_ES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;

export type WeekdayEs = (typeof DAY_NAMES_ES)[number];

/**
 * El único `new Date()` del flujo. Devuelve la hora actual del server.
 *
 * El repo no tiene configuración de zona horaria todavía; cuando la tenga,
 * este es el punto donde se aplica.
 */
export function reservationNow(): Date {
  return new Date();
}

/** Medianoche del día en curso — el límite de "fecha pasada". */
export function reservationToday(): Date {
  return startOfDay(reservationNow());
}

/** Copia de `date` a las 00:00 (no muta el argumento). */
export function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** Nombre del día de la semana en español, en minúscula y con tilde. */
export function weekdayNameEs(date: Date): WeekdayEs {
  return DAY_NAMES_ES[date.getDay()];
}

/** `DD/MM/AAAA` — el formato que hablan las tools, el borrador y el ledger. */
export function formatDMY(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getFullYear()}`;
}

/** `30/08/2026 (domingo)` — la línea de fecha actual del ledger. */
export function currentDateLabel(): string {
  const now = reservationNow();
  return `${formatDMY(now)} (${weekdayNameEs(now)})`;
}

/**
 * Próxima fecha (desde hoy, excluyéndolo) que cae en `weekday`. La usa el gate
 * para sugerirle al modelo la fecha correcta cuando el día que declaró no
 * coincide con el que calculó.
 */
export function nextDateForWeekday(weekday: WeekdayEs): Date {
  const target = DAY_NAMES_ES.indexOf(weekday);
  const date = reservationToday();
  let diff = target - date.getDay();
  if (diff <= 0) diff += 7;
  date.setDate(date.getDate() + diff);
  return date;
}
