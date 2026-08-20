/**
 * pendingOrderLines — cola de líneas de pedido cuando el cliente pide varios
 * platos en un mismo mensaje ("3 lomos, 2 ceviches y una bebida").
 *
 * Patrón alineado a tipables (pendingAddQuantity / pendingItemNote): NO es un
 * router regex. El alta la hace el ReAct con la tool `plan_order_lines`
 * (D2); la cola vive en metadata de sesión (no tabla de negocio, D1) y el
 * código (no el modelo) decide la línea activa y cuándo avanzar (D6).
 *
 * Ver PLAN-ACCION-PEDIDO-MULTI-LINEA.md.
 */

import { randomUUID } from 'node:crypto';
import {
  omitConversationMetadataKeys,
  patchConversationMetadata,
} from '../repositories';
import { normalizeMetadata } from './productQuery/utils';
import type { ConversationMetadata } from './productQuery/types';

export const PENDING_ORDER_LINES_KEY = 'pendingOrderLines' as const;

export const ORDER_LINES_MAX = 8;

export type OrderLineStatus = 'queued' | 'active' | 'done' | 'cancelled';

export type OrderLine = {
  id: string;
  hint: string;
  requestedQuantity: number | null;
  status: OrderLineStatus;
};

export type PendingOrderLines = {
  lines: OrderLine[];
  sourceMessage: string;
  createdAt: string;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

const parseLine = (raw: unknown): OrderLine | null => {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id.trim()) return null;
  if (typeof raw.hint !== 'string' || !raw.hint.trim()) return null;
  const requestedQuantity =
    typeof raw.requestedQuantity === 'number' && raw.requestedQuantity >= 1
      ? Math.min(99, Math.floor(raw.requestedQuantity))
      : null;
  const status: OrderLineStatus =
    raw.status === 'queued' ||
    raw.status === 'active' ||
    raw.status === 'done' ||
    raw.status === 'cancelled'
      ? raw.status
      : 'queued';
  return {
    id: raw.id.trim(),
    hint: raw.hint.trim(),
    requestedQuantity,
    status,
  };
};

export const parsePendingOrderLines = (raw: unknown): PendingOrderLines | null => {
  if (!isRecord(raw)) return null;
  if (!Array.isArray(raw.lines)) return null;
  const lines = raw.lines.map(parseLine).filter((l): l is OrderLine => l != null);
  if (lines.length === 0) return null;
  const sourceMessage = typeof raw.sourceMessage === 'string' ? raw.sourceMessage : '';
  const createdAt =
    typeof raw.createdAt === 'string' && raw.createdAt
      ? raw.createdAt
      : new Date().toISOString();
  return { lines, sourceMessage, createdAt };
};

export const getPendingOrderLines = (metadata: unknown): PendingOrderLines | null => {
  const meta = normalizeMetadata(metadata) as ConversationMetadata;
  return parsePendingOrderLines((meta as Record<string, unknown>).pendingOrderLines);
};

/** Línea activa (Constraint, D1): primera `active`, si no hay primera `queued`. */
export const getActiveOrderLine = (pending: PendingOrderLines | null): OrderLine | null => {
  if (!pending) return null;
  return (
    pending.lines.find((l) => l.status === 'active') ??
    pending.lines.find((l) => l.status === 'queued') ??
    null
  );
};

const STOPWORDS = new Set([
  'de',
  'del',
  'la',
  'las',
  'el',
  'los',
  'un',
  'una',
  'unos',
  'unas',
  'con',
  'sin',
  'al',
  'a',
  'y',
  'e',
  'en',
  'para',
  'por',
]);

/** Tokens comparables: sin acentos, sin stopwords, singular simple (papas → papa). */
const matchTokens = (value: string): Set<string> => {
  const tokens = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .map((t) => (t.endsWith('s') ? t.slice(0, -1) : t));
  return new Set(tokens);
};

/**
 * Qué línea abierta de la cola corresponde al producto que se está agregando.
 *
 * Determinístico y permitido por la norma: valida un **argumento de tool**
 * (`productId` → nombre del catálogo) contra el Fact de sesión; NO parsea el
 * mensaje del cliente. Se busca entre todas las líneas abiertas (no solo la
 * activa) porque el drenaje de unívocos (D5) puede cerrar varias en un turno.
 * Sin solapamiento de tokens devuelve null: mejor caer al flujo de hoy que
 * aplicar la cantidad de otra línea.
 */
export const resolveOrderLineForProduct = (
  pending: PendingOrderLines | null,
  productName: string
): OrderLine | null => {
  if (!pending) return null;
  const productTokens = matchTokens(productName);
  if (productTokens.size === 0) return null;

  const open = pending.lines.filter(
    (l) => l.status === 'queued' || l.status === 'active'
  );

  let best: { line: OrderLine; score: number } | null = null;
  for (const line of open) {
    let score = 0;
    for (const token of matchTokens(line.hint)) {
      if (productTokens.has(token)) score += 1;
    }
    if (score === 0) continue;
    // Empate: gana la línea activa (o la primera abierta, por orden del pedido).
    if (!best || score > best.score) best = { line, score };
  }
  return best?.line ?? null;
};

/** Cualquier línea aún sin cerrar (D7): gate para COMPLETAR_PEDIDO / SUGERIR_COMPLEMENTO. */
export const hasOpenOrderLines = (metadata: unknown): boolean => {
  const pending = getPendingOrderLines(metadata);
  if (!pending) return false;
  return pending.lines.some((l) => l.status === 'queued' || l.status === 'active');
};

export const countOpenOrderLines = (pending: PendingOrderLines | null): number => {
  if (!pending) return 0;
  return pending.lines.filter((l) => l.status === 'queued' || l.status === 'active').length;
};

/**
 * Alta de la cola (D2). Con 1 sola línea no vale la pena persistir cola:
 * el llamador decide si igual quiere crearla (p. ej. para no reescribir la
 * tool); acá solo se valida y arma el objeto.
 */
export const setPendingOrderLines = async (params: {
  conversationId: string;
  lines: Array<{ hint: string; requestedQuantity?: number | null }>;
  sourceMessage: string;
}): Promise<PendingOrderLines> => {
  const cleaned = params.lines
    .map((l) => ({
      hint: l.hint.trim(),
      requestedQuantity:
        l.requestedQuantity != null && l.requestedQuantity >= 1
          ? Math.min(99, Math.floor(l.requestedQuantity))
          : null,
    }))
    .filter((l) => l.hint.length > 0)
    .slice(0, ORDER_LINES_MAX);

  const lines: OrderLine[] = cleaned.map((l, idx) => ({
    id: randomUUID().slice(0, 8),
    hint: l.hint,
    requestedQuantity: l.requestedQuantity,
    status: idx === 0 ? 'active' : 'queued',
  }));

  const pending: PendingOrderLines = {
    lines,
    sourceMessage: params.sourceMessage.slice(0, 500),
    createdAt: new Date().toISOString(),
  };

  await patchConversationMetadata(params.conversationId, {
    pendingOrderLines: pending,
  });
  return pending;
};

export const clearPendingOrderLines = async (conversationId: string): Promise<void> => {
  await omitConversationMetadataKeys(conversationId, [PENDING_ORDER_LINES_KEY]);
};

/**
 * Cierra la línea activa (add exitoso o cancelación) y deja la siguiente en
 * `queued` — NO la activa todavía (D6): eso pasa recién cuando el cliente
 * dice que sigue.
 */
export const advanceAfterLineClose = async (params: {
  conversationId: string;
  metadata: unknown;
  lineId?: string | null;
  closeStatus: 'done' | 'cancelled';
}): Promise<PendingOrderLines | null> => {
  const pending = getPendingOrderLines(params.metadata);
  if (!pending) return null;
  const target =
    (params.lineId && pending.lines.find((l) => l.id === params.lineId)) ??
    getActiveOrderLine(pending);
  if (!target) return null;

  const nextLines = pending.lines.map((l) =>
    l.id === target.id ? { ...l, status: params.closeStatus } : l
  );
  const stillOpen = nextLines.some((l) => l.status === 'queued' || l.status === 'active');
  if (!stillOpen) {
    await clearPendingOrderLines(params.conversationId);
    return null;
  }
  const next: PendingOrderLines = { ...pending, lines: nextLines };
  await patchConversationMetadata(params.conversationId, { pendingOrderLines: next });
  return next;
};

/** El cliente confirma que sigue con la cola: activa la próxima `queued`. */
export const activateNextOrderLine = async (
  conversationId: string,
  metadata: unknown
): Promise<PendingOrderLines | null> => {
  const pending = getPendingOrderLines(metadata);
  if (!pending) return null;
  const alreadyActive = pending.lines.some((l) => l.status === 'active');
  if (alreadyActive) return pending;
  const nextQueuedIdx = pending.lines.findIndex((l) => l.status === 'queued');
  if (nextQueuedIdx === -1) return pending;
  const nextLines = pending.lines.map((l, idx) =>
    idx === nextQueuedIdx ? { ...l, status: 'active' as const } : l
  );
  const next: PendingOrderLines = { ...pending, lines: nextLines };
  await patchConversationMetadata(conversationId, { pendingOrderLines: next });
  return next;
};

/** Cancela una línea puntual por id o por hint (match laxo, primera coincidencia). */
export const cancelOrderLine = async (params: {
  conversationId: string;
  metadata: unknown;
  lineId?: string | null;
  hint?: string | null;
}): Promise<PendingOrderLines | null> => {
  const pending = getPendingOrderLines(params.metadata);
  if (!pending) return null;
  const target =
    (params.lineId && pending.lines.find((l) => l.id === params.lineId)) ??
    (params.hint &&
      pending.lines.find(
        (l) =>
          (l.status === 'queued' || l.status === 'active') &&
          l.hint.toLowerCase().includes(params.hint!.toLowerCase())
      )) ??
    getActiveOrderLine(pending);
  if (!target) return null;
  return advanceAfterLineClose({
    conversationId: params.conversationId,
    metadata: params.metadata,
    lineId: target.id,
    closeStatus: 'cancelled',
  });
};

/**
 * D6 — tras cerrar una línea con cola restante: instrucción para que el
 * ÚLTIMO mensaje del turno ofrezca seguir con la próxima o cancelar el
 * resto, sin arrancar la siguiente búsqueda a ciegas en el mismo turno.
 */
export const buildOrderLinesContinueOrCancelHint = (
  pending: PendingOrderLines
): { nextHint: string; remaining: number; instruction: string } | null => {
  const nextQueued = pending.lines.find((l) => l.status === 'queued');
  if (!nextQueued) return null;
  const remaining = countOpenOrderLines(pending);
  const qtyLabel = nextQueued.requestedQuantity
    ? ` (${nextQueued.requestedQuantity}×)`
    : '';
  return {
    nextHint: nextQueued.hint,
    remaining,
    instruction:
      `Quedan ${remaining} línea(s) de la cola de pedido. En tu mensaje de cierre de este turno, ` +
      `ofrecé seguir con *${nextQueued.hint}*${qtyLabel} o cancelar el resto — NO arranques ` +
      `search_products/present_product_cta de esa línea en este mismo turno; esperá la respuesta. ` +
      `PROHIBIDO present_complement_suggestions y preguntar "¿algo más?" mientras la cola siga abierta.`,
  };
};

/** Ledger para el híbrido (misma filosofía que pendingAddQuantity / pendingItemNote). */
export const buildPendingOrderLinesContextLines = (metadata: unknown): string[] => {
  const pending = getPendingOrderLines(metadata);
  if (!pending) return [];
  const active = getActiveOrderLine(pending);
  const queued = pending.lines.filter(
    (l) => l.status === 'queued' && l.id !== active?.id
  );

  const activeLabel = active
    ? `*${active.hint}*${active.requestedQuantity ? ` (${active.requestedQuantity}×)` : ''}`
    : null;
  const queuedLabels = queued.map(
    (l) => `*${l.hint}*${l.requestedQuantity ? ` (${l.requestedQuantity}×)` : ''}`
  );

  if (!activeLabel && queuedLabels.length === 0) return [];

  const parts: string[] = [];
  parts.push(
    `- Cola de pedido (varios platos en un mismo mensaje; NO es confirmación de cantidad): ` +
      `línea activa ahora → ${activeLabel ?? 'ninguna (activá la próxima con la tool que corresponda)'}` +
      (queuedLabels.length > 0 ? `. Después faltan: ${queuedLabels.join(', ')}.` : '.') +
      ` Trabajá SOLO la línea activa (search_products/find_products_by_filter con su hint, variación, cantidad) ` +
      `— NO relistes ni ofrezcas las demás como si fueran shortlist ahora. ` +
      `Si el requestedQuantity de la línea existe, PRIORIZALO sobre ceil(personas/porción) al sugerir/ask de cantidad. ` +
      `Al cerrar la línea (add exitoso o el cliente cancela esa línea), el sistema avanza la cola solo; ` +
      `en tu último mensaje del turno ofrecé seguir con la próxima o cancelar el resto ` +
      `(NO preguntes "¿algo más?" genérico, nombrá el hint siguiente). ` +
      `"seguí"/"dale con..." → continuá con esa línea; "cancelá el resto"/"nada más" → clear_pending_order_lines(). ` +
      `PROHIBIDO ofrecer complementos (present_complement_suggestions) o abrir COMPLETAR_PEDIDO mientras esta cola siga abierta.`
  );
  return parts;
};
