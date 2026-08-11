/**
 * pendingItemNote — ledger de captura de nota por ítem.
 *
 * Patrón tipables / pendingAddQuantity: NO es un router regex pre-ReAct.
 * El híbrido lee el ledger en [ESTADO DEL CLIENTE] y confirma con
 * update_item_note(productId, note) o cancela con clear_pending_item_note().
 * Gate duro solo en la tool (ítem en carrito).
 */

import {
  omitConversationMetadataKeys,
  patchConversationMetadata,
} from '../repositories';
import type { ConversationMetadata } from './productQuery/types';
import { formatBotUserMessage, normalizeMetadata } from './productQuery/utils';

export const PENDING_ITEM_NOTE_KEY = 'pendingItemNote' as const;

export type PendingItemNoteSource = 'tipable' | 'payload' | 'hybrid';

export type PendingItemNote = {
  askedAt: string;
  /** productId si ya se sabe el ítem; null si hay que desambiguar */
  productId?: string | null;
  productName?: string | null;
  /** Nota ya dicha mientras se desambigua el alcance */
  noteText?: string | null;
  /** productIds candidatos cuando hubo ≥2 matches */
  candidateProductIds?: string[];
  source: PendingItemNoteSource;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

export const parsePendingItemNote = (raw: unknown): PendingItemNote | null => {
  if (!isRecord(raw)) return null;
  const source =
    raw.source === 'tipable' || raw.source === 'payload' || raw.source === 'hybrid'
      ? raw.source
      : 'hybrid';
  const askedAt =
    typeof raw.askedAt === 'string' && raw.askedAt
      ? raw.askedAt
      : new Date().toISOString();
  const productId =
    typeof raw.productId === 'string' && raw.productId.trim()
      ? raw.productId.trim()
      : raw.productId === null
        ? null
        : undefined;
  const productName =
    typeof raw.productName === 'string' && raw.productName.trim()
      ? raw.productName.trim()
      : raw.productName === null
        ? null
        : undefined;
  const noteText =
    typeof raw.noteText === 'string'
      ? raw.noteText.trim() || null
      : raw.noteText === null
        ? null
        : undefined;
  const candidateProductIds = Array.isArray(raw.candidateProductIds)
    ? raw.candidateProductIds.filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0
      )
    : undefined;

  return {
    askedAt,
    ...(productId !== undefined ? { productId } : {}),
    ...(productName !== undefined ? { productName } : {}),
    ...(noteText !== undefined ? { noteText } : {}),
    ...(candidateProductIds && candidateProductIds.length > 0
      ? { candidateProductIds }
      : {}),
    source,
  };
};

export const getPendingItemNote = (metadata: unknown): PendingItemNote | null => {
  const meta = normalizeMetadata(metadata) as ConversationMetadata;
  return parsePendingItemNote(meta.pendingItemNote);
};

export const setPendingItemNote = async (params: {
  conversationId: string;
  productId?: string | null;
  productName?: string | null;
  noteText?: string | null;
  candidateProductIds?: string[];
  source?: PendingItemNoteSource;
}): Promise<PendingItemNote> => {
  const pending: PendingItemNote = {
    askedAt: new Date().toISOString(),
    productId:
      typeof params.productId === 'string' && params.productId.trim()
        ? params.productId.trim()
        : params.productId === null
          ? null
          : undefined,
    productName:
      typeof params.productName === 'string' && params.productName.trim()
        ? params.productName.trim()
        : params.productName === null
          ? null
          : undefined,
    noteText:
      typeof params.noteText === 'string'
        ? params.noteText.trim() || null
        : params.noteText === null
          ? null
          : undefined,
    candidateProductIds: params.candidateProductIds?.filter(
      (id) => typeof id === 'string' && id.trim().length > 0
    ),
    source: params.source ?? 'hybrid',
  };
  // Limpiar undefined opcionales vacíos para metadata limpia
  if (pending.candidateProductIds?.length === 0) {
    delete pending.candidateProductIds;
  }
  await patchConversationMetadata(params.conversationId, {
    pendingItemNote: pending,
  });
  return pending;
};

export const clearPendingItemNote = async (
  conversationId: string
): Promise<void> => {
  await omitConversationMetadataKeys(conversationId, [PENDING_ITEM_NOTE_KEY]);
};

/**
 * Ask estándar D5. Con 1 ítem (y nombre opcional) no pide desambiguar plato.
 */
export function buildPendingItemNoteMessage(
  cartItemCount: number,
  productName?: string | null
): string {
  const single =
    cartItemCount === 1 &&
    typeof productName === 'string' &&
    productName.trim().length > 0;

  const inner = single
    ? `Decime la instrucción para *${productName!.trim()}*\n` +
      `(ej.: "poca sal", "sin azúcar", "término medio").`
    : `Decime la instrucción y, si hay más de un plato, sobre cuál\n` +
      `(ej.: "el chupe sin picante", "poca sal en la chicha").`;

  return formatBotUserMessage('¿Qué querés anotar?', '📝', inner);
}

/** Ledger para el híbrido: prioridad sobre shortlist / complementos. */
export const buildPendingItemNoteContextLines = (
  metadata: unknown
): string[] => {
  const pending = getPendingItemNote(metadata);
  if (!pending) return [];

  const itemHint = pending.productId
    ? `ítem ya fijado: *${pending.productName ?? 'producto'}* (productId: ${pending.productId})`
    : 'ítem aún no fijado — desambiguá con get_cart si hace falta';
  const noteHint =
    pending.noteText != null && pending.noteText !== ''
      ? ` Nota ya capturada (mientras desambiguás alcance): "${pending.noteText}".`
      : '';
  const candidates =
    pending.candidateProductIds && pending.candidateProductIds.length > 0
      ? ` Candidatos (≥2 matches): ${pending.candidateProductIds.join(', ')}.`
      : '';

  return [
    `- Nota de ítem pendiente (tipable; el mensaje actual probablemente ES la nota o plato+nota): ` +
      `${itemHint}.${noteHint}${candidates} ` +
      `PRIORIDAD ABSOLUTA sobre shortlist de productos y complementos. ` +
      `PROHIBIDO add_cart_item, present_complement_suggestions y present_product_cta ` +
      `salvo que el cliente pida explícitamente otro plato. ` +
      `Si el mensaje trae nota (+ plato si hace falta): get_cart → update_item_note(productId, note) ` +
      `en un solo paso (sin re-preguntar qué anotar). ` +
      `Si ≥2 líneas matchean el mismo plato: preguntá si aplica a todas o solo una; ` +
      `podés dejar noteText/candidateProductIds en el ledger vía start_item_note. ` +
      `Si cancela ("cancelar", "mejor no", "nada"): clear_pending_item_note() y confirmá breve.`,
  ];
};
