/**
 * Tools exclusivas del agente de reservas.
 *
 * Se agrupan en cuatro categorías:
 *  - Escritura: persisten datos en `reservation_draft` vía metadata.
 *  - Consulta: leen disponibilidad o el estado actual de la DB.
 *  - Señal-UI: devuelven un marcador estructurado que el nodo interpreta para
 *    adjuntar listas/botones WhatsApp sin que el agente los genere en texto.
 *  - Salida: finalizan o delegan la sesión de reservas.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getReactContext } from './_context';
import { omitConversationMetadataKeys } from '../repositories/conversationState.repository';
import {
  fetchReservationSlotsForBusinessDate,
  findAnyFutureOccupyingReservationForCustomer,
  findActiveEnvironmentsByBusinessId,
  findActiveTablesByBusinessAndEnvironment,
  findOverlappingReservationForTable,
  findReservationBlockAtStart,
} from '../repositories/reservation.repository';
import { buildDateTime, normalizeDate } from '../services/reservations/utils';
import { patchReservationDraft } from '../services/reservations/draft.repository';
import { getBusinessConfig } from '../services/businessConfig.service';
import { prisma } from '../lib/prisma';
import type { RunnableConfig } from '@langchain/core/runnables';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toJson = (data: unknown): string => JSON.stringify(data);

/**
 * Gate en el borde (D7/R-G): formato DD/MM/AAAA válido y no en el pasado.
 * El prompt ya le pedía esto al modelo; acá se garantiza aunque lo ignore.
 */
function validateReservationDateGate(
  date: string
): { ok: true } | { ok: false; error: 'invalid_date' | 'past_date' } {
  let parsed: Date;
  try {
    parsed = normalizeDate(date);
  } catch {
    return { ok: false, error: 'invalid_date' };
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (parsed < today) {
    return { ok: false, error: 'past_date' };
  }
  return { ok: true };
}

/** Capacidad máxima combinable del negocio (suma de mesas activas). D7/R-G. */
async function getMaxCombinablePartySize(businessId: string): Promise<number> {
  const tables = await findActiveTablesByBusinessAndEnvironment(businessId);
  return tables.reduce((sum, t) => sum + t.capacity, 0);
}

// ---------------------------------------------------------------------------
// ESCRITURA: save_reservation_date
// ---------------------------------------------------------------------------

const saveReservationDateSchema = z.object({
  date: z
    .string()
    .describe('Fecha ya resuelta en formato DD/MM/AAAA. Debe venir de resolve_date.'),
});
type SaveReservationDateInput = z.infer<typeof saveReservationDateSchema>;

export const saveReservationDateTool = new DynamicStructuredTool<
  typeof saveReservationDateSchema,
  SaveReservationDateInput
>({
  name: 'save_reservation_date',
  description:
    'Persiste la fecha de la reserva (formato DD/MM/AAAA) en el borrador, sin perder horario/personas/ambiente ya cargados. ' +
    'Preferí resolve_date para obtenerla, pero si devuelve null y ya la resolviste vos mismo con el contexto (fecha actual del ledger), llamá esta tool directo con DD/MM/AAAA. ' +
    'Devuelve { saved: false, error: "invalid_date" | "past_date" } si el formato es inválido o la fecha ya pasó.',
  schema: saveReservationDateSchema,
  func: async ({ date }: SaveReservationDateInput, _runManager, config?: RunnableConfig) => {
    const { conversationId } = getReactContext(config);
    const gate = validateReservationDateGate(date);
    if (!gate.ok) {
      return toJson({ saved: false, error: gate.error });
    }
    // Merge con el draft existente (P0.1/D1): nunca pisar slotId/partySize/environmentId.
    await patchReservationDraft(conversationId, { date });
    return toJson({ saved: true, date });
  },
});

// ---------------------------------------------------------------------------
// ESCRITURA: save_reservation_party_size
// ---------------------------------------------------------------------------

const saveReservationPartySizeSchema = z.object({
  count: z
    .number()
    .int()
    .positive()
    .describe('Cantidad de personas para la reserva.'),
});
type SaveReservationPartySizeInput = z.infer<typeof saveReservationPartySizeSchema>;

export const saveReservationPartySizeTool = new DynamicStructuredTool<
  typeof saveReservationPartySizeSchema,
  SaveReservationPartySizeInput
>({
  name: 'save_reservation_party_size',
  description:
    'Persiste la cantidad de personas de la reserva en el borrador. ' +
    'Llamar cuando el cliente indique cuántas personas asistirán. ' +
    'Devuelve { saved: false, error: "party_size_too_large", max } si excede la capacidad combinable del local.',
  schema: saveReservationPartySizeSchema,
  func: async ({ count }: SaveReservationPartySizeInput, _runManager, config?: RunnableConfig) => {
    const { conversationId, businessId } = getReactContext(config);
    const max = await getMaxCombinablePartySize(businessId);
    if (max > 0 && count > max) {
      return toJson({ saved: false, error: 'party_size_too_large', max });
    }
    await patchReservationDraft(conversationId, { partySize: count });
    return toJson({ saved: true, partySize: count });
  },
});

// ---------------------------------------------------------------------------
// ESCRITURA: save_reservation_environment
// ---------------------------------------------------------------------------

const saveReservationEnvironmentSchema = z.object({
  environmentId: z
    .string()
    .nullable()
    .describe(
      'UUID del ambiente elegido o null si el cliente no tiene preferencia.'
    ),
});
type SaveReservationEnvironmentInput = z.infer<typeof saveReservationEnvironmentSchema>;

export const saveReservationEnvironmentTool = new DynamicStructuredTool<
  typeof saveReservationEnvironmentSchema,
  SaveReservationEnvironmentInput
>({
  name: 'save_reservation_environment',
  description:
    'Persiste la preferencia de ambiente de la reserva. ' +
    'Pasá el id del catálogo del [ESTADO] / get_available_environments cuando el cliente nombre un ambiente en prosa. ' +
    'Pasá null cuando el cliente diga que no tiene preferencia o que le da lo mismo.',
  schema: saveReservationEnvironmentSchema,
  func: async ({ environmentId }: SaveReservationEnvironmentInput, _runManager, config?: RunnableConfig) => {
    const { conversationId } = getReactContext(config);
    await patchReservationDraft(conversationId, { environmentId });
    return toJson({ saved: true, environmentId });
  },
});

// ---------------------------------------------------------------------------
// CONSULTA: resolve_date
// ---------------------------------------------------------------------------

const resolveDateSchema = z.object({
  text: z
    .string()
    .describe(
      'Texto libre del cliente con la fecha. Ej: "el próximo viernes", "pasado mañana", "el 15", "23/07".'
    ),
  currentDate: z
    .string()
    .describe('Fecha actual en formato DD/MM/AAAA (inyectada por el contexto).'),
});

/**
 * Convierte texto libre de fecha a DD/MM/AAAA usando lógica de calendario.
 * Soporta expresiones relativas (próximo viernes, pasado mañana, etc.) y
 * formatos parciales (DD/MM → completa el año actual).
 */
const resolveDateSchemaTyped = resolveDateSchema;
type ResolveDateInput = z.infer<typeof resolveDateSchemaTyped>;

export const resolveDateTool = new DynamicStructuredTool<
  typeof resolveDateSchemaTyped,
  ResolveDateInput
>({
  name: 'resolve_date',
  description:
    'Convierte un texto libre con una fecha ("el próximo viernes", "el 15", "23/07") ' +
    'al formato DD/MM/AAAA usando la fecha actual como referencia. ' +
    'Siempre llamar antes de get_available_slots. ' +
    'Devuelve { date: "DD/MM/AAAA" } o { date: null, error: "..." } si no puede resolver.',
  schema: resolveDateSchemaTyped,
  func: async ({ text, currentDate }: ResolveDateInput, _runManager, config?: RunnableConfig) => {
    getReactContext(config); // validar contexto
    try {
      const resolved = resolveDateText(text, currentDate);
      if (!resolved) {
        return toJson({ date: null, error: 'No pude interpretar la fecha.' });
      }
      return toJson({ date: resolved });
    } catch {
      return toJson({ date: null, error: 'Error al resolver la fecha.' });
    }
  },
});

/**
 * Lógica de resolución de fechas en texto libre.
 * Soporta: DD/MM, DD/MM/AAAA, "hoy", "mañana", "pasado mañana",
 * "próximo {día}", "el {día}" con referencia a currentDate.
 */
function resolveDateText(text: string, currentDate: string): string | null {
  const t = text.trim().toLowerCase();

  // Parsear fecha actual
  const [cd, cm, cy] = currentDate.split('/').map(Number);
  if (!cd || !cm || !cy) return null;
  const now = new Date(cy, cm - 1, cd);

  // Formato DD/MM/AAAA o DD/MM
  const fullMatch = t.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}))?$/);
  if (fullMatch) {
    const d = parseInt(fullMatch[1], 10);
    const m = parseInt(fullMatch[2], 10);
    const y = fullMatch[3] ? parseInt(fullMatch[3], 10) : now.getFullYear();
    const candidate = new Date(y, m - 1, d);
    // Si la fecha ya pasó este año, usar el próximo
    if (candidate < now && !fullMatch[3]) {
      candidate.setFullYear(y + 1);
    }
    return formatDMY(candidate);
  }

  if (t === 'hoy') return formatDMY(now);

  if (t === 'mañana') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return formatDMY(d);
  }

  if (t === 'pasado mañana' || t === 'pasado manana') {
    const d = new Date(now);
    d.setDate(d.getDate() + 2);
    return formatDMY(d);
  }

  // "próximo lunes", "el viernes", "este sábado", etc.
  const DAY_NAMES: Record<string, number> = {
    domingo: 0, lunes: 1, martes: 2, miércoles: 3, miercoles: 3,
    jueves: 4, viernes: 5, sábado: 6, sabado: 6,
  };
  const dayMatch = t.match(
    /(?:próximo|proximo|el|este|el próximo|el proximo)?\s*(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)/
  );
  if (dayMatch) {
    const targetDay = DAY_NAMES[dayMatch[1]];
    if (targetDay !== undefined) {
      const d = new Date(now);
      const currentDay = d.getDay();
      let diff = targetDay - currentDay;
      if (diff <= 0) diff += 7;
      d.setDate(d.getDate() + diff);
      return formatDMY(d);
    }
  }

  // "el 15", "el día 15"
  const dayOnlyMatch = t.match(/(?:el\s+)?(?:d[ií]a\s+)?(\d{1,2})$/);
  if (dayOnlyMatch) {
    const day = parseInt(dayOnlyMatch[1], 10);
    const candidate = new Date(now.getFullYear(), now.getMonth(), day);
    if (candidate < now) {
      candidate.setMonth(candidate.getMonth() + 1);
    }
    return formatDMY(candidate);
  }

  return null;
}

function formatDMY(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

// ---------------------------------------------------------------------------
// CONSULTA: get_active_reservation
// ---------------------------------------------------------------------------

const getActiveReservationSchema = z.object({});
type GetActiveReservationInput = z.infer<typeof getActiveReservationSchema>;

export const getActiveReservationTool = new DynamicStructuredTool<
  typeof getActiveReservationSchema,
  GetActiveReservationInput
>({
  name: 'get_active_reservation',
  description:
    'Consulta si el cliente tiene una reserva futura activa (confirmada) en la DB. ' +
    'Devuelve { hasReservation: true, date, time, endTime, partySize } o { hasReservation: false }.',
  schema: getActiveReservationSchema,
  func: async (_input: GetActiveReservationInput, _runManager, config?: RunnableConfig) => {
    const { customerId, businessId } = getReactContext(config);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const reservation = await findAnyFutureOccupyingReservationForCustomer(
      customerId,
      startOfToday
    );
    if (!reservation) return toJson({ hasReservation: false });

    const date = formatDMY(reservation.reservation_date);
    const startTime =
      reservation.start_time instanceof Date
        ? `${String(reservation.start_time.getUTCHours()).padStart(2, '0')}:${String(reservation.start_time.getUTCMinutes()).padStart(2, '0')}`
        : String(reservation.start_time).substring(0, 5);
    const endTime =
      reservation.end_time instanceof Date
        ? `${String(reservation.end_time.getUTCHours()).padStart(2, '0')}:${String(reservation.end_time.getUTCMinutes()).padStart(2, '0')}`
        : String(reservation.end_time).substring(0, 5);

    // Filtrar por negocio actual
    if (reservation.business_id !== businessId) {
      return toJson({ hasReservation: false });
    }

    return toJson({
      hasReservation: true,
      reservationId: reservation.id,
      date,
      time: startTime,
      endTime,
      partySize: reservation.party_size,
      status: reservation.status,
    });
  },
});

// ---------------------------------------------------------------------------
// CONSULTA: check_availability
// ---------------------------------------------------------------------------

const checkAvailabilitySchema = z.object({
  date: z.string().describe('Fecha en formato DD/MM/AAAA.'),
  slotId: z.string().describe('ID del slot de reserva.'),
  partySize: z.number().int().positive(),
  environmentId: z
    .string()
    .nullable()
    .optional()
    .describe('ID del ambiente o null para sin preferencia.'),
});
type CheckAvailabilityInput = z.infer<typeof checkAvailabilitySchema>;

export const checkAvailabilityTool = new DynamicStructuredTool<
  typeof checkAvailabilitySchema,
  CheckAvailabilityInput
>({
  name: 'check_availability',
  description:
    'Verifica de forma determinística si hay mesa disponible para la fecha, slot, ' +
    'cantidad de personas y ambiente indicados. ' +
    'Devuelve { available: true, tableIds } o { available: false, reason }.',
  schema: checkAvailabilitySchema,
  func: async (
    { date, slotId, partySize, environmentId }: CheckAvailabilityInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    const { businessId } = getReactContext(config);
    try {
      const parsedDate = normalizeDate(date);
      const slot = await prisma.reservation_slot.findFirst({
        where: { id: slotId, business_id: businessId, is_active: true },
      });
      if (!slot) return toJson({ available: false, reason: 'slot_not_found' });

      const startDateTime = buildDateTime(parsedDate, String(slot.start_time).substring(0, 5));
      const endDateTime = buildDateTime(parsedDate, String(slot.end_time).substring(0, 5));

      const tables = await findActiveTablesByBusinessAndEnvironment(
        businessId,
        environmentId ?? undefined
      );
      const suitable = tables.filter((t) => t.capacity >= partySize);
      if (!suitable.length) {
        return toJson({ available: false, reason: 'no_tables_for_party_size' });
      }

      // Verificar disponibilidad de cada mesa
      const availableTables: string[] = [];
      for (const table of suitable) {
        const overlap = await findOverlappingReservationForTable(
          table.id,
          parsedDate,
          startDateTime
        );
        if (overlap) continue;
        const block = await findReservationBlockAtStart(
          table.id,
          environmentId ?? null,
          parsedDate,
          startDateTime
        );
        if (block) continue;
        availableTables.push(table.id);
        if (availableTables.length >= 2) break; // suficiente
      }

      if (!availableTables.length) {
        return toJson({
          available: false,
          reason: 'no_available_tables',
          date,
          slotId,
          startTime: String(slot.start_time).substring(0, 5),
          endTime: String(slot.end_time).substring(0, 5),
        });
      }

      return toJson({
        available: true,
        tableIds: availableTables,
        startTime: String(slot.start_time).substring(0, 5),
        endTime: String(slot.end_time).substring(0, 5),
      });
    } catch {
      return toJson({ available: false, reason: 'error' });
    }
  },
});

// ---------------------------------------------------------------------------
// SEÑAL-UI: get_available_slots
// ---------------------------------------------------------------------------

const getAvailableSlotsSchema = z.object({
  date: z.string().describe('Fecha en formato DD/MM/AAAA.'),
});
type GetAvailableSlotsInput = z.infer<typeof getAvailableSlotsSchema>;

/**
 * Señal: el nodo fetchea los slots de la DB y adjunta la lista de WhatsApp.
 * El agente NO escribe los horarios en texto; solo llama esta tool.
 */
export const getAvailableSlotsTool = new DynamicStructuredTool<
  typeof getAvailableSlotsSchema,
  GetAvailableSlotsInput
>({
  name: 'get_available_slots',
  description:
    'Muestra al cliente la lista de horarios disponibles para la fecha indicada. ' +
    'NUNCA listes los horarios en texto: siempre llamá esta tool. ' +
    'Solo llamar después de haber resuelto la fecha con resolve_date.',
  schema: getAvailableSlotsSchema,
  func: async ({ date }: GetAvailableSlotsInput, _runManager, config?: RunnableConfig) => {
    getReactContext(config); // validar contexto
    return toJson({ signal: 'present_slots', date });
  },
});

// ---------------------------------------------------------------------------
// SEÑAL-UI: get_available_environments
// ---------------------------------------------------------------------------

const getAvailableEnvironmentsSchema = z.object({});
type GetAvailableEnvironmentsInput = z.infer<typeof getAvailableEnvironmentsSchema>;

/**
 * Señal: el nodo adjunta la lista de ambientes del negocio.
 * También devuelve el catálogo id↔nombre para que el agente pueda
 * mapear prosa ("salón principal") a `save_reservation_environment`.
 */
export const getAvailableEnvironmentsTool = new DynamicStructuredTool<
  typeof getAvailableEnvironmentsSchema,
  GetAvailableEnvironmentsInput
>({
  name: 'get_available_environments',
  description:
    'Muestra al cliente los ambientes disponibles del restaurante para que elija. ' +
    'NUNCA listes los ambientes en texto: siempre llamá esta tool. ' +
    'Devuelve el catálogo con id para usar en save_reservation_environment si el cliente responde en prosa.',
  schema: getAvailableEnvironmentsSchema,
  func: async (_input: GetAvailableEnvironmentsInput, _runManager, config?: RunnableConfig) => {
    const { businessId } = getReactContext(config);
    const environments = await findActiveEnvironmentsByBusinessId(businessId);
    return toJson({
      signal: 'present_environments',
      environments: environments.map((e) => ({ id: e.id, name: e.name })),
    });
  },
});

// ---------------------------------------------------------------------------
// SEÑAL-UI: present_confirmation
// ---------------------------------------------------------------------------

const presentConfirmationSchema = z.object({});
type PresentConfirmationInput = z.infer<typeof presentConfirmationSchema>;

/**
 * Señal: el nodo lee `reservation_draft`, arma el resumen y adjunta los
 * botones RESERVATION_CONFIRM / RESERVATION_CANCEL.
 */
export const presentConfirmationTool = new DynamicStructuredTool<
  typeof presentConfirmationSchema,
  PresentConfirmationInput
>({
  name: 'present_confirmation',
  description:
    'Muestra al cliente el resumen de la reserva y los botones para confirmar o cancelar. ' +
    'Solo llamar cuando ya tenés fecha, slot, personas (y ambiente si aplica). ' +
    'El nodo construye el mensaje; no lo escribas vos.',
  schema: presentConfirmationSchema,
  func: async (_input: PresentConfirmationInput, _runManager, config?: RunnableConfig) => {
    getReactContext(config); // validar contexto
    return toJson({ signal: 'present_confirmation' });
  },
});

// ---------------------------------------------------------------------------
// SEÑAL: resolve_reservation_confirmation (D3, R-C/R-D)
// ---------------------------------------------------------------------------

const resolveReservationConfirmationSchema = z.object({
  confirmed: z
    .boolean()
    .describe('true si el cliente confirmó la reserva en texto, false si la canceló.'),
});
type ResolveReservationConfirmationInput = z.infer<
  typeof resolveReservationConfirmationSchema
>;

/**
 * Señal: el cliente respondió "sí, confirmo" / "no, cancelá" en texto libre
 * en vez de tocar los botones. Es una señal, nunca crea ni cancela la
 * reserva por sí misma (ADR-0004) — el nodo ejecuta la misma función que
 * usa para RESERVATION_CONFIRM / RESERVATION_CANCEL, sin importar el canal.
 */
export const resolveReservationConfirmationTool = new DynamicStructuredTool<
  typeof resolveReservationConfirmationSchema,
  ResolveReservationConfirmationInput
>({
  name: 'resolve_reservation_confirmation',
  description:
    'Llamar cuando el cliente responde en TEXTO a la confirmación de la reserva (ej. "sí, confirmo", "dale", "no, mejor no") ' +
    'en vez de tocar los botones. Nunca listes esto como pregunta al cliente: solo interpretá su respuesta y llamá esta tool.',
  schema: resolveReservationConfirmationSchema,
  func: async (
    { confirmed }: ResolveReservationConfirmationInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    getReactContext(config); // validar contexto
    return toJson({ signal: 'resolve_reservation_confirmation', confirmed });
  },
});

// ---------------------------------------------------------------------------
// SALIDA: delegate_to_main (temporal — no limpia reservation_agent_active)
// ---------------------------------------------------------------------------

const delegateToMainSchema = z.object({
  reason: z
    .string()
    .describe(
      'Motivo de la delegación en una oración. ' +
        'Ej: "el cliente preguntó por el menú", "el cliente quiere saber el precio de un plato".'
    ),
});
type DelegateToMainInput = z.infer<typeof delegateToMainSchema>;

/**
 * Delegación temporal: el nodo llama `runHybridReactAgent` con el mismo mensaje
 * y devuelve esa respuesta. `reservation_agent_active` NO se limpia.
 * En el siguiente turno el cliente vuelve automáticamente al agente de reservas.
 */
export const delegateToMainTool = new DynamicStructuredTool<
  typeof delegateToMainSchema,
  DelegateToMainInput
>({
  name: 'delegate_to_main',
  description:
    'Delega el turno al asistente principal para responder una pregunta off-topic. ' +
    'La sesión de reserva sigue activa: el próximo mensaje del cliente vuelve al agente de reservas. ' +
    'Usá esta tool cuando el cliente pregunta algo fuera de la reserva (menú, precios, horarios). ' +
    'NO la uses para abandono definitivo: usá abandon_reservation en ese caso.',
  schema: delegateToMainSchema,
  func: async ({ reason }: DelegateToMainInput, _runManager, config?: RunnableConfig) => {
    getReactContext(config); // validar contexto
    return toJson({ signal: 'delegate_to_main', reason });
  },
});

// ---------------------------------------------------------------------------
// SALIDA: handback_reservation (temporal — conserva reservation_draft)
// ---------------------------------------------------------------------------

const handbackReservationSchema = z.object({
  reason: z
    .string()
    .describe(
      'Motivo del handback en una oración corta. ' +
        'Ej: "el cliente quiere ver el menú", "el cliente quiere hacer un pedido".'
    ),
});
type HandbackReservationInput = z.infer<typeof handbackReservationSchema>;

/**
 * Salida temporal (Fase 1b, ADR-0005): el nodo limpia `reservation_agent_active`
 * pero CONSERVA `reservation_draft` — a diferencia de `abandon_reservation`, que
 * borra los dos. El cliente vuelve al flujo normal, y el borrador sigue vivo
 * por si retoma la reserva más adelante: es lo que hace posible que el Goal
 * `COMPLETAR_RESERVA` pueda reabrirse (ver `reservationCompletionGoal.service.ts`).
 * Mismo patrón que `handback_to_main` en checkout.
 */
export const handbackReservationTool = new DynamicStructuredTool<
  typeof handbackReservationSchema,
  HandbackReservationInput
>({
  name: 'handback_reservation',
  description:
    'Sale de la sesión de reserva y devuelve el control al asistente principal, SIN perder ' +
    'los datos ya cargados (fecha, horario, personas, ambiente). ' +
    'Usá esta tool cuando el cliente quiera hacer algo fuera de la reserva mientras la sigue queriendo ' +
    'completar más tarde: ver el menú, hacer un pedido, cambiar de tema sin cancelar. ' +
    'NO la uses si el cliente decide explícitamente no reservar: para eso usá abandon_reservation, ' +
    'que sí borra el borrador.',
  schema: handbackReservationSchema,
  func: async ({ reason }: HandbackReservationInput, _runManager, config?: RunnableConfig) => {
    getReactContext(config); // validar contexto
    return toJson({ signal: 'handback_reservation', reason });
  },
});

// ---------------------------------------------------------------------------
// SALIDA: abandon_reservation (permanente — limpia reservation_agent_active)
// ---------------------------------------------------------------------------

const abandonReservationSchema = z.object({
  reason: z
    .string()
    .describe(
      'Motivo del abandono. Ej: "el cliente decidió no reservar", "el cliente canceló explícitamente".'
    ),
});
type AbandonReservationInput = z.infer<typeof abandonReservationSchema>;

/**
 * Abandono permanente: el nodo limpia `reservation_agent_active` y `reservation_draft`.
 * El siguiente mensaje del cliente no vuelve al agente de reservas.
 */
export const abandonReservationTool = new DynamicStructuredTool<
  typeof abandonReservationSchema,
  AbandonReservationInput
>({
  name: 'abandon_reservation',
  description:
    'Cancela la sesión de reserva activa de forma permanente. ' +
    'Usá esta tool cuando el cliente decide explícitamente no hacer la reserva o no completarla. ' +
    'Para preguntas off-topic temporales usá delegate_to_main en cambio.',
  schema: abandonReservationSchema,
  func: async ({ reason }: AbandonReservationInput, _runManager, config?: RunnableConfig) => {
    const { conversationId } = getReactContext(config);
    await omitConversationMetadataKeys(conversationId, [
      'reservation_agent_active',
      'reservation_draft',
    ]);
    return toJson({ signal: 'abandon_reservation', reason });
  },
});

// ---------------------------------------------------------------------------
// ENTRADA: start_reservation_session (agente híbrido → reservas)
// ---------------------------------------------------------------------------

const startReservationSessionSchema = z.object({
  reason: z
    .string()
    .describe(
      'Motivo de la delegación en una oración. ' +
        'Ej: "el cliente quiere reservar una mesa", "el cliente pidió ver su reserva".'
    ),
});
type StartReservationSessionInput = z.infer<typeof startReservationSessionSchema>;

/**
 * Espejo de `start_checkout_session`: el híbrido no puede abrir la sesión de
 * reservas por su cuenta, así que emite la señal y el nodo `nlpSubgraph`
 * activa `reservation_agent_active` e invoca al agente en el mismo turno.
 *
 * Gate en el borde: si el negocio no tiene reservas habilitadas, no hay sesión
 * que abrir (el prompt no alcanza — ADR-0002).
 */
export const startReservationSessionTool = new DynamicStructuredTool<
  typeof startReservationSessionSchema,
  StartReservationSessionInput
>({
  name: 'start_reservation_session',
  description:
    'Delega al agente de reservas cuando el cliente quiere RESERVAR una mesa o gestionar/ver una reserva ' +
    '("quiero reservar", "tienen mesa para el sábado?", "mesa para 4", "ver mi reserva", "cancelar mi reserva"). ' +
    'NO gestiones vos fecha, horario, personas ni ambiente de la reserva: solo delegá con esta tool. ' +
    'No la uses para pedidos de comida (eso es carrito/menú).',
  schema: startReservationSessionSchema,
  func: async (
    { reason }: StartReservationSessionInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    const { businessId } = getReactContext(config);
    const businessConfig = await getBusinessConfig(businessId);

    if (!businessConfig.reservations_enabled) {
      return toJson({
        success: false,
        error: 'reservations_disabled',
        message: 'Este negocio no toma reservas; no se puede iniciar una sesión de reserva.',
      });
    }

    return toJson({ signal: 'start_reservation_session', reason });
  },
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const allReservationTools = [
  saveReservationDateTool,
  saveReservationPartySizeTool,
  saveReservationEnvironmentTool,
  resolveDateTool,
  getActiveReservationTool,
  checkAvailabilityTool,
  getAvailableSlotsTool,
  getAvailableEnvironmentsTool,
  presentConfirmationTool,
  resolveReservationConfirmationTool,
  delegateToMainTool,
  handbackReservationTool,
  abandonReservationTool,
];
