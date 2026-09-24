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

const UNIT_NUMBER_WORDS: Record<string, number> = {
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
};

function normalizeQtyMessage(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Quita frases de party size para no tomar "somos 3" como unidades del plato. */
function stripPartySizePhrases(normalized: string): string {
  return normalized
    .replace(
      /\b(somos|para)\s+(\d+|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s*(personas?)?\b/gi,
      ' '
    )
    .replace(
      /\b(mesa|comida)\s+para\s+(\d+|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/gi,
      ' '
    )
    .replace(
      /\bcomemos\s+(\d+|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/gi,
      ' '
    );
}

function quantityToken(q: number): string {
  const words = Object.entries(UNIT_NUMBER_WORDS)
    .filter(([, n]) => n === q)
    .map(([w]) => w);
  const alts = [String(q), ...words].join('|');
  return `(?:${alts})`;
}

/**
 * El mensaje del turno afirma `quantity` como unidades a sumar (no party size).
 * Validación del argumento de tool contra el texto del cliente (no regex de tipable).
 */
export function userMessageStatesUnitQuantity(
  userMessage: string | null | undefined,
  quantity: number
): boolean {
  if (!userMessage || !Number.isFinite(quantity)) return false;
  const q = Math.floor(quantity);
  if (q < 1 || q > 99) return false;

  const normalized = stripPartySizePhrases(normalizeQtyMessage(userMessage));
  if (!normalized) return false;

  const tok = quantityToken(q);
  const patterns = [
    // dame/sumá/quiero + N
    new RegExp(
      `\\b(?:dame|damelo|sumame|sumamele|suma|sumá|agrega|agregame|agregá|agregalo|poneme|ponele|poné|pone|quiero|pedime|pedimele|traeme|me\\s+das|me\\s+pones)\\s+${tok}\\b`,
      'i'
    ),
    // N de / N x / N×
    new RegExp(`\\b${tok}\\s*(?:[x×]\\s*|de\\b)`, 'i'),
    // N + nombre de plato ("dos adobo", "2 ají")
    new RegExp(`\\b${tok}\\s+[a-zñ]`, 'i'),
  ];

  return patterns.some((re) => re.test(normalized));
}

/**
 * Qty del payload/tool cuenta como confirmada por el cliente (no abrir pending).
 *
 * `explicitToolQuantity`: el argumento `quantity` de `add_cart_item` confirma
 * solo. El modelo ya extrajo las unidades; no hace falta que el texto matchee
 * `userMessageStatesUnitQuantity`.
 *
 * Sin ese flag (botón/CTA), suggested ≥ 2 no se confirma con el número pelado
 * (el `:1` del CTA es “sumar”, no “una unidad”). Confirma:
 * - `pendingReply` (respuesta al ask de unidades), o
 * - el mensaje del turno afirma esa cantidad como unidades ("dame dos adobo").
 *
 * - suggested < 2: cualquier n ≥ 1 se escribe (no hay pending que abrir).
 */
export function isConfirmedAddQuantity(params: {
  quantity: number | null | undefined;
  suggestedQuantity: number;
  /** True si hay pendingAddQuantity del mismo producto y el cliente pasó quantity. */
  pendingReply?: boolean;
  /** Texto del turno actual: si afirma las unidades, confirma aunque suggested ≥ 2. */
  userMessage?: string | null;
  /** `quantity` vino en el tool call de add_cart_item, no en un payload de botón. */
  explicitToolQuantity?: boolean;
}): boolean {
  const q = params.quantity;
  if (q == null || q < 1) return false;
  if (params.explicitToolQuantity) return true;
  if (params.pendingReply) return true;
  if (params.suggestedQuantity < 2) return true;
  return userMessageStatesUnitQuantity(params.userMessage, q);
}
