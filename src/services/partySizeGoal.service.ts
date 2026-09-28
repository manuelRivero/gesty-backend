/**
 * OBTENER_PERSONAS_DEL_PEDIDO — Goal blocking (PLAN-ACCION-PARTY-SIZE-GOAL).
 *
 * Sin Fact PERSONAS_DEL_PEDIDO no hay porciones/recomendaciones útiles.
 * Proyección pura sobre Facts + señal de comida; Ledger de insistencia aparte.
 * Alias ledger legacy: RECOLECTAR_PARTY_SIZE (migración suave).
 */

import { getIntentCatalogEntry, type IntentCandidate } from '../domain/intent/family';
import { computeCatalogPermission, type IntentLedgerEntry } from './intent/activeIntent.service';
import { patchIntentLedgerEntry } from './intentLedger.repository';
import {
  findOrCreateConversationState,
  omitConversationMetadataKeys,
  patchConversationMetadata,
} from '../repositories';
import type { ConversationMetadata } from './productQuery/types';
import { getRequestedPartySize, normalizeMetadata } from './productQuery/utils';
import {
  getPendingSwitchToReservation,
} from './switchToReservationConfirm.service';
import { isReservationFaqMode } from './reservationFaqDelegation.service';

export const PARTY_SIZE_GOAL_TYPE = 'OBTENER_PERSONAS_DEL_PEDIDO' as const;
/** Key histórica en intentLedger (Opportunity ambient C.3). */
export const PARTY_SIZE_GOAL_LEGACY_TYPE = 'RECOLECTAR_PARTY_SIZE' as const;

export const hasActivePedirHumanIntent = (metadata: unknown): boolean => {
  const rawState = (
    normalizeMetadata(metadata) as ConversationMetadata & { humanIntentState?: unknown }
  ).humanIntentState;
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) return false;
  const records = (rawState as { records?: unknown }).records;
  return Array.isArray(records) && records.some((record) =>
    typeof record === 'object' &&
    record !== null &&
    (record as { goal?: unknown }).goal === 'PEDIR' &&
    (record as { status?: unknown }).status === 'ACTIVE'
  );
};

/**
 * Intents NLP como feature de apertura (Fase A — deuda documentada).
 * Prohibido inyectar el intent como hint al agente.
 */
export const FOOD_RELATED_INTENTS_FOR_PARTY_SIZE = new Set([
  'ORDER_FOOD',
  'PRODUCT_QUERY',
  'ADD_ITEM',
  'VIEW_MENU',
  'MODIFY_QUANTITY',
  'RECOMMENDATION_REQUEST',
  'PRODUCT_ATTRIBUTE_QUESTION',
]);

export type PartySizeGoalFacts = {
  /** Fact PERSONAS_DEL_PEDIDO ausente. */
  partySize: number | null;
  /** Señal de comida (turno NLP Fase A y/o metadata Fase B). */
  foodRelatedSignal: boolean;
  checkoutActive: boolean;
  /**
   * Dominio reserva con ownership de turno (RES-05 opción 1): no abrir
   * party size de pedido. Ver `blocksOrderPartySizeForReservationDomain`.
   */
  reservationDomainActive?: boolean;
};

/** Payload estándar de tools cuando falta el Fact de personas. */
export const PARTY_SIZE_REQUIRED_TOOL_PAYLOAD = {
  success: false as const,
  error: 'party_size_required' as const,
  pending: true as const,
  instruction:
    'Falta cuántas personas comen (Goal OBTENER_PERSONAS_DEL_PEDIDO). ' +
    'Preguntá el número (1–99) con el título *¿Para cuántas personas?*, ' +
    'llamá save_party_size cuando lo diga, y recién después continuá con shortlist / add. ' +
    'NO busques productos ni digas que ya sumaste.',
};

/**
 * Comida que la tool de pedido ya traía cuando el gate de personas la frenó.
 * `plan` (plan_order_lines) gana sobre búsquedas del mismo turno.
 * Una línea de prosa en [ESTADO DEL CLIENTE]. save_party_size no la borra:
 * se va al pasar a la cola o al carrito, al cancelar, o si un lookup de otro turno la reemplaza.
 */
export const PENDING_PARTY_SIZE_ORDER_KEY = 'pendingPartySizeOrder' as const;

const PENDING_PARTY_SIZE_ORDER_MAX = 240;

export type PartySizeBlockedFoodSource = 'plan' | 'lookup';

export type PendingPartySizeOrder = {
  source: PartySizeBlockedFoodSource;
  summary: string;
  setAt: string;
  /** Inicio del turno ReAct que escribió este pending. Cruza turnos, no el texto. */
  turnStartedAt?: string | null;
};

const collapseFoodText = (value: string): string => value.replace(/\s+/g, ' ').trim();

const clipFoodSummary = (value: string): string =>
  value.length <= PENDING_PARTY_SIZE_ORDER_MAX
    ? value
    : value.slice(0, PENDING_PARTY_SIZE_ORDER_MAX).trim();

export const getPendingPartySizeOrder = (
  metadata: unknown
): PendingPartySizeOrder | null => {
  const raw = normalizeMetadata(metadata).pendingPartySizeOrder;
  if (!raw || typeof raw !== 'object') return null;
  if (raw.source !== 'plan' && raw.source !== 'lookup') return null;
  if (typeof raw.summary !== 'string' || !raw.summary.trim()) return null;
  if (typeof raw.setAt !== 'string' || !raw.setAt) return null;
  return {
    source: raw.source,
    summary: raw.summary.trim(),
    setAt: raw.setAt,
    ...(typeof raw.turnStartedAt === 'string' ? { turnStartedAt: raw.turnStartedAt } : {}),
  };
};

/** Arma el resumen de plan_order_lines / filtro / add. No mira el mensaje del cliente. */
export const summarizeBlockedOrderLines = (
  lines: Array<{ hint: string; requestedQuantity?: number | null }>
): string =>
  lines
    .map((line) => {
      const hint = collapseFoodText(line.hint ?? '');
      if (!hint) return '';
      return line.requestedQuantity != null && line.requestedQuantity > 0
        ? `${line.requestedQuantity}× ${hint}`
        : hint;
    })
    .filter(Boolean)
    .join(', ');

export const summarizeBlockedFilter = (input: {
  categoryTag?: string | null;
  containsIngredient?: string | null;
  excludesIngredient?: string | null;
  minServesPeople?: number | null;
}): string => {
  const bits: string[] = [];
  const tag = input.categoryTag?.trim();
  if (tag) bits.push(tag);
  const ingredient = collapseFoodText(input.containsIngredient ?? '');
  if (ingredient) bits.push(ingredient);
  const excluded = collapseFoodText(input.excludesIngredient ?? '');
  if (excluded) bits.push(`sin ${excluded}`);
  if (input.minServesPeople != null && input.minServesPeople > 0) {
    bits.push(`ración para ${input.minServesPeople}`);
  }
  return bits.join(', ');
};

export const summarizeBlockedAdd = (input: {
  name: string;
  quantity?: number | null;
  variation?: string | null;
}): string => {
  const name = collapseFoodText(input.name ?? '');
  if (!name) return '';
  const qty =
    input.quantity != null && input.quantity > 0 ? `${input.quantity}× ` : '';
  const variation = collapseFoodText(input.variation ?? '');
  return variation ? `${qty}${name} (${variation})` : `${qty}${name}`;
};

const samePartySizeTurn = (
  current: PendingPartySizeOrder,
  incomingTurn: string | null | undefined
): boolean => {
  if (!incomingTurn || !current.turnStartedAt) return true;
  return current.turnStartedAt === incomingTurn;
};

/**
 * plan pisa lo ya guardado. lookup del mismo turno se suma.
 * Un lookup no pisa un plan. Un lookup de otro turno reemplaza un lookup viejo.
 */
export const mergePartySizeBlockedFood = (
  current: PendingPartySizeOrder | null,
  incoming: {
    source: PartySizeBlockedFoodSource;
    summary: string;
    turnStartedAt?: string | null;
  }
): PendingPartySizeOrder | null => {
  const piece = clipFoodSummary(collapseFoodText(incoming.summary));
  if (!piece) return current;
  const setAt = new Date().toISOString();
  const turnStartedAt = incoming.turnStartedAt ?? null;
  if (incoming.source === 'plan' || !current) {
    return { source: incoming.source, summary: piece, setAt, turnStartedAt };
  }
  if (current.source === 'plan') return current;
  if (!samePartySizeTurn(current, turnStartedAt)) {
    return { source: 'lookup', summary: piece, setAt, turnStartedAt };
  }
  const parts = current.summary.split(', ').map((part) => part.toLowerCase());
  if (parts.includes(piece.toLowerCase())) return current;
  return {
    source: 'lookup',
    summary: clipFoodSummary(`${current.summary}, ${piece}`),
    setAt: current.setAt,
    turnStartedAt: current.turnStartedAt ?? null,
  };
};

export const partySizeRequiredPayload = (heldOrder?: string | null) => {
  const held = heldOrder?.trim();
  if (!held) return PARTY_SIZE_REQUIRED_TOOL_PAYLOAD;
  return {
    ...PARTY_SIZE_REQUIRED_TOOL_PAYLOAD,
    heldOrder: held,
    instruction:
      `${PARTY_SIZE_REQUIRED_TOOL_PAYLOAD.instruction} ` +
      `Pedido en espera: ${held}. Nombralo al pedir el número; no lo des por sumado.`,
  };
};

export const buildPendingPartySizeOrderContextLines = (metadata: unknown): string[] => {
  const pending = getPendingPartySizeOrder(metadata);
  if (!pending) return [];
  const resume =
    'Retomalo (si hay varios platos, plan_order_lines; si no, search_products o add_cart_item). ' +
    'No lo trates como ya sumado.';
  if (getRequestedPartySize(normalizeMetadata(metadata)) != null) {
    return [
      `- Pedido en espera (personas ya guardadas): ${pending.summary}. ${resume}`,
    ];
  }
  return [
    `- Pedido en espera del número: ${pending.summary}. ` +
      `Preguntá las personas; cuando save_party_size guarde el número, ${resume}`,
  ];
};

/**
 * Cola por conversación. Las tools en paralelo leen, fusionan y escriben
 * una detrás de la otra, releyendo la fila, en este proceso.
 * No es un lock global ni cambia patchConversationMetadata.
 */
const rememberQueues = new Map<string, Promise<unknown>>();

const enqueuePartySizeRemember = <T>(
  conversationId: string,
  task: () => Promise<T>
): Promise<T> => {
  const previous = rememberQueues.get(conversationId) ?? Promise.resolve();
  const run = previous.then(task, task);
  rememberQueues.set(conversationId, run);
  void run.finally(() => {
    if (rememberQueues.get(conversationId) === run) {
      rememberQueues.delete(conversationId);
    }
  });
  return run;
};

export const rememberPartySizeBlockedFood = async (
  conversationId: string,
  incoming: { source: PartySizeBlockedFoodSource; summary: string },
  turnStartedAt?: string | null
): Promise<string | null> =>
  enqueuePartySizeRemember(conversationId, async () => {
    const state = await findOrCreateConversationState(conversationId);
    const current = getPendingPartySizeOrder(state.metadata);
    const next = mergePartySizeBlockedFood(current, {
      ...incoming,
      turnStartedAt,
    });
    if (!next) return current?.summary ?? null;
    if (
      current &&
      current.summary === next.summary &&
      current.source === next.source
    ) {
      return current.summary;
    }
    await patchConversationMetadata(conversationId, {
      pendingPartySizeOrder: next,
    });
    return next.summary;
  });

export const clearPendingPartySizeOrder = async (
  conversationId: string
): Promise<void> => {
  await omitConversationMetadataKeys(conversationId, [PENDING_PARTY_SIZE_ORDER_KEY]);
};

/**
 * Ownership de turno en dominio reserva → no competir con personas del pedido.
 *
 * Fuentes (Facts / metadata, sin diccionario de prosa):
 * - FAQ mid-reserva o `reservation_agent_active` (`isReservationFaqMode`)
 * - Pendiente confirmar cancelar carrito para pasar a reserva
 *
 * No usa `reservation_draft` solo: tras handback el cliente puede armar pedido
 * y sí necesita party size de pedido.
 */
export const blocksOrderPartySizeForReservationDomain = (
  metadata: unknown
): boolean => {
  if (isReservationFaqMode(metadata)) return true;
  if (getPendingSwitchToReservation(metadata)) return true;
  return false;
};

/**
 * Gate duro de tools de pedido/shortlist: sin Fact PERSONAS no hay catálogo
 * orientado a pedir ni add. Excepciones: checkout, dominio reserva activo, abandono.
 */
export const isPartySizeMissingForOrderingTools = (metadata: unknown): boolean => {
  const meta = normalizeMetadata(metadata);
  if (getRequestedPartySize(meta) != null) return false;
  if (meta.checkout_active === true) return false;
  if (blocksOrderPartySizeForReservationDomain(meta)) return false;
  if (getPartySizeGoalLedger(meta).abandonment) return false;
  return true;
};

export type PartySizeGoalLedger = {
  abandonment: boolean;
  surfaceCount: number;
  lastSurfacedAt: string | null;
};

const EMPTY_LEDGER: PartySizeGoalLedger = {
  abandonment: false,
  surfaceCount: 0,
  lastSurfacedAt: null,
};

/** Lee ledger nuevo o legacy RECOLECTAR_PARTY_SIZE. */
export const getPartySizeGoalLedger = (metadata: unknown): PartySizeGoalLedger => {
  const meta: ConversationMetadata = normalizeMetadata(metadata);
  const ledger = meta.intentLedger;
  const entry =
    ledger?.[PARTY_SIZE_GOAL_TYPE] ??
    (ledger as Record<string, IntentLedgerEntry> | undefined)?.[PARTY_SIZE_GOAL_LEGACY_TYPE];
  return {
    abandonment: entry?.abandonment === true,
    surfaceCount: entry?.surfaceCount ?? 0,
    lastSurfacedAt: entry?.lastSurfacedAt ?? null,
  };
};

export type PartySizeGoal = {
  open: boolean;
};

/**
 * Derivador puro: abierto ⟺ falta Fact + señal comida + no checkout + no
 * abandono. La cantidad por línea de cola NO cierra el Goal: personas van
 * siempre antes del shortlist/add.
 */
export const derivePartySizeGoal = (
  facts: PartySizeGoalFacts,
  ledger: PartySizeGoalLedger
): PartySizeGoal => ({
  open:
    facts.partySize == null &&
    facts.foodRelatedSignal &&
    !facts.checkoutActive &&
    !facts.reservationDomainActive &&
    !ledger.abandonment,
});

/**
 * Señal “el usuario pregunta por comida” sin Ownership.
 * Fase A: intents NLP. Fase B: shortlist / offer / CTA / producto referenciado.
 */
export const isFoodRelatedPartySizeSignal = (params: {
  detectionIntent?: string | null;
  metadata: ConversationMetadata;
  lastReferencedProductId?: string | null;
}): boolean => {
  const intent = params.detectionIntent;
  if (intent && FOOD_RELATED_INTENTS_FOR_PARTY_SIZE.has(String(intent))) {
    return true;
  }
  const meta = params.metadata;
  if (meta.pendingProductSelection === true) return true;
  if ((meta.candidateProductIds?.length ?? 0) > 0) return true;
  if (meta.lastOffer?.kind === 'ADD_ITEM') return true;
  if (meta.lastCtaProductId) return true;
  if (params.lastReferencedProductId) return true;
  return false;
};

export const derivePartySizeGoalCandidate = (
  facts: PartySizeGoalFacts,
  ledgerEntry: IntentLedgerEntry | undefined,
  now: number = Date.now()
): IntentCandidate | null => {
  const ledger: PartySizeGoalLedger = {
    abandonment: ledgerEntry?.abandonment === true,
    surfaceCount: ledgerEntry?.surfaceCount ?? 0,
    lastSurfacedAt: ledgerEntry?.lastSurfacedAt ?? null,
  };
  if (!derivePartySizeGoal(facts, ledger).open) return null;

  const perm = computeCatalogPermission(PARTY_SIZE_GOAL_TYPE, ledgerEntry ?? {}, now);
  if (!perm.granted) return null;

  const cat = getIntentCatalogEntry(PARTY_SIZE_GOAL_TYPE);
  return {
    type: PARTY_SIZE_GOAL_TYPE,
    kind: cat.kind,
    pressure: cat.pressure,
    closeMode: cat.closeMode,
    hint:
      '- Goal (OBTENER_PERSONAS_DEL_PEDIDO, blocking): falta cuántas personas comen. ' +
      'PRIMERO preguntá el número (1–99); DESPUÉS shortlist / CTA / add. ' +
      'PROHIBIDO search_products, find_products_by_filter, present_product_cta, present_category, ' +
      'plan_order_lines o add_cart_item hasta save_party_size. ' +
      'Cuando lo diga, persistilo con save_party_size y recién ahí continuá con la comida del turno.',
    tieBreak: 95,
  };
};

/** Resuelve entry de ledger (nuevo o legacy) para el ranker / surface. */
export const resolvePartySizeLedgerEntry = (
  metadata: unknown
): IntentLedgerEntry | undefined => {
  const meta: ConversationMetadata = normalizeMetadata(metadata);
  const ledger = meta.intentLedger;
  return (
    ledger?.[PARTY_SIZE_GOAL_TYPE] ??
    (ledger as Record<string, IntentLedgerEntry> | undefined)?.[PARTY_SIZE_GOAL_LEGACY_TYPE]
  );
};

export const recordPartySizeGoalSurfaced = async (
  conversationId: string,
  metadata: unknown
): Promise<void> => {
  const prev = resolvePartySizeLedgerEntry(metadata) ?? {};
  await patchIntentLedgerEntry(conversationId, PARTY_SIZE_GOAL_TYPE, {
    ...prev,
    surfaceCount: (prev.surfaceCount ?? 0) + 1,
    lastSurfacedAt: new Date().toISOString(),
  });
};

export const recordPartySizeGoalAbandonment = async (
  conversationId: string,
  metadata: unknown
): Promise<void> => {
  const prev = resolvePartySizeLedgerEntry(metadata) ?? {};
  await patchIntentLedgerEntry(conversationId, PARTY_SIZE_GOAL_TYPE, {
    ...prev,
    abandonment: true,
  });
};
