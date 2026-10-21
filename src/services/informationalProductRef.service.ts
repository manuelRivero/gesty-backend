/**
 * Referente conversacional de producto para consultas INFORMATIVAS
 * ("¿cuánto cuesta el ceviche?" → "¿y qué ingredientes tiene?").
 *
 * Deliberadamente separado de `lastOffer`/ledger de oportunidades y de
 * `lastReferencedProductId` (columna `conversation`, de uso comercial vía
 * `ctaResolver`): este referente nunca debe autorizar ni insinuar una venta
 * por sí solo. Solo se fija cuando `search_products`/`find_products_by_filter`
 * resuelven exactamente 1 producto (sin ambigüedad); se reemplaza con el
 * siguiente match único; expira con el mismo TTL que las `ProductResolution`
 * (`PRODUCT_RESOLUTION_TTL_MS`) para que ambos mecanismos decaigan juntos.
 *
 * Un `add_cart_item` sobre este producto sigue pasando, sin excepción, por
 * las validaciones existentes de `ProductResolution` (disponibilidad, TTL,
 * consumo, variaciones) — este servicio no las modifica ni las saltea.
 */

import { patchConversationMetadata } from '../repositories';
import { normalizeMetadata } from './productQuery/utils';
import type { ConversationMetadata } from './productQuery/types';
import { PRODUCT_RESOLUTION_TTL_MS } from './productResolution.service';

export const INFORMATIONAL_PRODUCT_REF_KEY = 'lastInformationalProductRef' as const;

export type InformationalProductRef = {
  productId: string;
  name: string;
  setAt: string;
  expiresAt: string;
};

/**
 * Fija (o reemplaza) el referente informativo. Llamar únicamente cuando una
 * búsqueda de catálogo resolvió exactamente 1 producto sin ambigüedad.
 */
export const rememberInformationalProductRef = async (
  conversationId: string,
  product: { productId: string; name: string }
): Promise<void> => {
  const now = new Date();
  const ref: InformationalProductRef = {
    productId: product.productId,
    name: product.name,
    setAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PRODUCT_RESOLUTION_TTL_MS).toISOString(),
  };
  await patchConversationMetadata(conversationId, {
    [INFORMATIONAL_PRODUCT_REF_KEY]: ref,
  });
};

/** Lee el referente vigente (null si no existe, está corrupto o venció). */
export const getInformationalProductRef = (
  metadata: unknown
): InformationalProductRef | null => {
  const meta: ConversationMetadata = normalizeMetadata(metadata);
  const raw = meta.lastInformationalProductRef;
  if (!raw || typeof raw !== 'object') return null;
  const { productId, name, setAt, expiresAt } = raw;
  if (
    typeof productId !== 'string' || !productId ||
    typeof name !== 'string' || !name ||
    typeof setAt !== 'string' ||
    typeof expiresAt !== 'string'
  ) {
    return null;
  }
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return null;
  return { productId, name, setAt, expiresAt };
};

/**
 * Referente informativo vigente, o `null` si hay una selección pendiente
 * (`pendingProductSelection`) activa: esa ambigüedad tiene prioridad y la
 * resuelve el mecanismo existente — nunca se elige en su lugar un producto
 * del referente informativo. Único punto de esta regla; tanto el prompt de
 * ReAct (`buildInformationalProductRefContextLines`) como el contexto que
 * recibe el Human Intent Preflight (`recentProductRef`, ver
 * `humanIntentPreflight.service.ts`) la consultan acá en vez de duplicarla.
 */
export const getApplicableInformationalProductRef = (
  metadata: unknown
): InformationalProductRef | null => {
  const meta: ConversationMetadata = normalizeMetadata(metadata);
  if (meta.pendingProductSelection) return null;
  return getInformationalProductRef(meta);
};

/**
 * Línea de `[ESTADO DEL CLIENTE]` para el referente informativo. Se omite
 * si hay una selección pendiente (`pendingProductSelection`) activa: esa
 * ambigüedad tiene prioridad y la resuelve el mecanismo existente.
 */
export const buildInformationalProductRefContextLines = (
  metadata: unknown
): string[] => {
  const ref = getApplicableInformationalProductRef(metadata);
  if (!ref) return [];
  return [
    `- Último producto consultado (informativo, NO es oferta ni selección): ` +
      `*${ref.name}* (ID: ${ref.productId}). Si la siguiente pregunta sigue hablando de ` +
      `ese plato sin nombrarlo (p. ej. "¿y qué ingredientes tiene?", "¿viene con papas?"), ` +
      `usá get_products_details_by_ids con ese ID. Si el cliente nombra otro plato, ese pasa ` +
      `a ser el referente. Un "agregalo"/"agregame uno" sobre este plato sigue yendo por ` +
      `add_cart_item con las validaciones normales (no asumas que ya está confirmado).`,
  ];
};
