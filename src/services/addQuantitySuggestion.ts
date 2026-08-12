/**
 * Sugerencia de unidades a sumar según party size y serves_people (D2).
 * No escribe el carrito: solo calcula el número a proponer en pendingAddQuantity.
 */

export type SuggestAddQuantityReason =
  | 'portion_math'
  | 'party_unknown_serves'
  | 'default_one';

export type SuggestAddQuantityResult = {
  suggestedQuantity: number;
  reason: SuggestAddQuantityReason;
};

/**
 * - Ambos conocidos: ceil(party/serves), mínimo 1.
 * - serves desconocido y party ≥ 2: suggested = party (orientación).
 * - Resto: 1.
 */
export function suggestAddQuantity(params: {
  partySize: number | null | undefined;
  servesPeople: number | null | undefined;
}): SuggestAddQuantityResult {
  const party =
    params.partySize != null && params.partySize >= 1
      ? Math.min(99, Math.floor(params.partySize))
      : null;
  const serves =
    params.servesPeople != null && params.servesPeople > 0
      ? Math.floor(params.servesPeople)
      : null;

  if (party != null && serves != null) {
    const need = Math.ceil(party / serves);
    const suggestedQuantity = Math.min(99, Math.max(1, need));
    return {
      suggestedQuantity,
      reason: suggestedQuantity > 1 ? 'portion_math' : 'default_one',
    };
  }

  if (party != null && party >= 2 && serves == null) {
    return {
      suggestedQuantity: Math.min(99, party),
      reason: 'party_unknown_serves',
    };
  }

  return { suggestedQuantity: 1, reason: 'default_one' };
}

/**
 * D3: hay que pedir confirmación de cantidad antes de escribir el carrito.
 * Si suggested ≥ 2 → siempre. Si suggested === 1 solo cuando party > 1 no aplica
 * (suggested ya es 1).
 */
export function needsAddQuantityConfirmation(params: {
  suggestedQuantity: number;
  partySize: number | null | undefined;
}): boolean {
  return params.suggestedQuantity >= 2;
}

/**
 * Qty del payload/tool cuenta como confirmada por el cliente (no abrir pending).
 *
 * Si suggested ≥ 2, un número que manda el LLM/CTA NO confirma: party size y
 * “la primera” se copian como quantity y saltaban el pending. Solo confirma
 * `pendingReply` (el cliente respondió al ask de unidades).
 *
 * - n === 1 sin pending: solo si suggested < 2; si suggested ≥ 2, el `:1` del
 *   CTA es intención de sumar, no confirmación (abre pending).
 * - suggested < 2: cualquier n ≥ 1 se escribe (no hay pending que abrir).
 * - Con pendingReply: cualquier n ≥ 1 confirma, incluido 1 (“solo una”).
 */
export function isConfirmedAddQuantity(params: {
  quantity: number | null | undefined;
  suggestedQuantity: number;
  /** True si hay pendingAddQuantity del mismo producto y el cliente pasó quantity. */
  pendingReply?: boolean;
}): boolean {
  const q = params.quantity;
  if (q == null || q < 1) return false;
  if (params.pendingReply) return true;
  return params.suggestedQuantity < 2;
}
