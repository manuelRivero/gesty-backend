// src/services/intent/detectionService.ts

import OpenAI from 'openai';
import { ConversationIntent } from '../../types/conversationIntent';
import { wantsReservationManagement } from '../reservations/reservationIntentText';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export interface DetectionContext {
  conversationMode: string;
  lastReferencedProductId: string | null;
  candidateProductIds: string[] | null;
  recentMessages: string[];
  lastReferencedProductName?: string | null;
}

export interface IntentDetectionResult {
  intent: ConversationIntent;
  confidence: number;
  detectedProductName: string | null;
  quantity: number | null;
  addressText?: string | null;
  addressConfidence?: number | null;
  candidates: Array<{
    intent: ConversationIntent;
    confidence: number;
  }>;
  resolutionSource?: 'direct' | 'rescued' | 'unknown';
  topCandidate?: {
    intent: ConversationIntent;
    confidence: number;
  } | null;
  rescueMargin?: number | null;
  raw: string | null;
}


export const detectIntentWithConfidence = async (
  message: string,
  context: DetectionContext
): Promise<IntentDetectionResult> => {

  const prompt = buildDetectionPrompt(message, context);

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are an intent classifier for a restaurant WhatsApp bot.
Analyze the user's message and return structured intent information.

Available intents:
- ORDER_FOOD: wants to order/add something (e.g., "quiero una hamburguesa", "dame 2 pizzas")
- REMOVE_ITEM: wants to remove/delete something from order (e.g., "sacá la pizza", "quitame la coca")
- MODIFY_QUANTITY: wants to change quantity (e.g., "cambiá a 3", "son 4 en total")
- PRODUCT_QUERY: user searches for food — any ingredient, dish type, or generic food word (e.g. "tienen ceviche?", "pollo para 3 personas", "algo con carne", "hay postres", "qué tienen de pescado"). Always set detectedProductName to the food keyword (pollo, carne, pescado, etc.) when the user names food, even if generic or no exact menu match exists.
- PRODUCT_ATTRIBUTE_QUESTION: asking about product details (e.g., "cuánto cuesta?", "es picante?")
- VIEW_MENU: ONLY when the user wants to browse the full catalog WITHOUT naming a specific food or ingredient. Examples: "ver menú", "mostrar el menú", "mostrar categorías", a very short standalone "qué tienen?" with no dish/ingredient. Do NOT use VIEW_MENU if the user mentions any food, ingredient, or dish — use PRODUCT_QUERY with detectedProductName instead. Headcount alone (e.g. "para 3 personas") with a food word is PRODUCT_QUERY + quantity, not VIEW_MENU.
- VIEW_CART: wants to see current cart (e.g., "cuánto llevo?", "ver mi pedido")
- VIEW_CART_FOR_EDITION: wants to see current cart for edition (e.g., "modificar mi pedido")
- SMALL_TALK: greeting or casual (e.g., "hola", "buenas")
- ASK_QUESTION: general question (e.g., "dónde están?", "cuál es el horario?")
- BUSINESS_HOURS: asks for business hours (e.g., "horarios", "a qué hora abren?")
- EDIT_ADDRESS: wants to change or update the delivery address (e.g., "quiero cambiar mi dirección")
- RESERVATION: wants to reserve a table OR manage an existing reservation (e.g., "reservar mesa", "gestionar reserva", "modificar reserva", "cancelar reserva", "mesa para 4"). Use RESERVATION for any change/cancel/manage intent about a booking, not only new bookings.
- VIEW_RESERVATION: wants to only see reservation details without managing (e.g., "ver mi reserva", "mostrar mi reserva", "consultar datos de mi reserva", "mi reserva" when asking to display info). Do NOT use VIEW_RESERVATION for "gestionar", "modificar", "cancelar", "editar" reserva — those are RESERVATION.
- VIEW_QR: wants to view reservation QR code (e.g., "ver qr", "mostrar codigo qr", "pasame el qr")
- UNKNOWN: cannot classify

Rules:
- Priority: if the user mentions any food or ingredient, prefer PRODUCT_QUERY over VIEW_MENU (never classify food-seeking messages as VIEW_MENU).
- Extract product name when mentioned
- Extract quantity when specified (number or words like "dos", "tres"). For "pedido/orden para N personas" or "somos N", quantity is N people (party size), not item count.
- If the user includes a delivery address, extract it in addressText even if there is a greeting
- If there is a clear address, still return intent but always include addressText
- Provide confidence 0-1
- If uncertain, provide top 2-3 candidates`
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    const content = response.choices[0]?.message?.content || '{}';

    try {
      const parsed = JSON.parse(content);

      let detectedProductName: string | null =
        typeof parsed.detectedProductName === 'string'
          ? parsed.detectedProductName.trim() || null
          : null;

      // Normalizar intent principal y candidatos para resolver un intent final estable
      const parsedConfidence =
        typeof parsed.confidence === 'number' ? parsed.confidence : 0;
      const initialIntent = normalizeIntent(parsed.intent || '');
      const normalizedCandidates = normalizeCandidates(parsed.candidates);
      const resolved = resolveFinalIntent(
        initialIntent,
        parsedConfidence,
        normalizedCandidates
      );
      let finalIntent = resolved.intent;

      // Context override: PRODUCT_FOCUS domina PRODUCT_QUERY
      if (context.conversationMode === 'PRODUCT_FOCUS') {

        const lower = message.toLowerCase().trim();
      
        const isLikelyAttribute =
          lower.startsWith('lleva') ||
          lower.startsWith('tiene') ||
          lower.startsWith('es ') ||
          lower.startsWith('trae') ||
          (lower.endsWith('?') && lower.split(' ').length <= 4);
      
        const explicitlySearchingNewDish =
          lower.includes('tienen') ||
          lower.includes('hay') ||
          lower.includes('algo con') ||
          lower.includes('platos con');
      
        if (
          finalIntent === ConversationIntent.PRODUCT_QUERY &&
          isLikelyAttribute &&
          !explicitlySearchingNewDish
        ) {
          console.log('[Detection] Forced ATTRIBUTE in PRODUCT_FOCUS');
          finalIntent = ConversationIntent.PRODUCT_ATTRIBUTE_QUESTION;
        }
      }

      // Extraer cantidad de texto si no viene en JSON
      let quantity = parsed.quantity ?? extractQuantityFromText(message);

      const coerced = applyViewMenuPartyIntentOverride({
        message,
        intent: finalIntent,
        quantity,
        parsedConfidence,
        detectedProductName
      });
      finalIntent = coerced.intent;
      quantity = coerced.quantity;
      const outConfidence = coerced.confidence;

      const productQueryPriority = applyProductQueryPriorityRules({
        message,
        intent: finalIntent,
        detectedProductName
      });
      finalIntent = productQueryPriority.intent;
      detectedProductName = productQueryPriority.detectedProductName;

      if (
        finalIntent === ConversationIntent.VIEW_RESERVATION &&
        wantsReservationManagement(message)
      ) {
        finalIntent = ConversationIntent.RESERVATION;
      }

      return {
        intent: finalIntent,
        confidence: outConfidence,
        detectedProductName,
        quantity,
        addressText:
          typeof parsed.addressText === 'string' ? parsed.addressText.trim() : null,
        addressConfidence:
          typeof parsed.addressConfidence === 'number' ? parsed.addressConfidence : null,
        candidates: normalizedCandidates,
        resolutionSource: resolved.source,
        topCandidate: resolved.topCandidate,
        rescueMargin: resolved.margin,
        raw: content
      };

    } catch (parseError) {
      console.error('[Detection] JSON parse error:', parseError);
      return {
        intent: ConversationIntent.UNKNOWN,
        confidence: 0,
        detectedProductName: null,
        quantity: null,
        addressText: null,
        addressConfidence: null,
        candidates: [],
        raw: content
      };
    }

  } catch (error) {
    console.error('[Detection] OpenAI error:', error);
    return {
      intent: ConversationIntent.UNKNOWN,
      confidence: 0,
      detectedProductName: null,
      quantity: null,
      addressText: null,
      addressConfidence: null,
      candidates: [],
      raw: String(error)
    };
  }
};


const buildDetectionPrompt = (
  message: string,
  context: DetectionContext
): string => {
  return `
USER MESSAGE: "${message}"

CONVERSATION CONTEXT:
- Mode: ${context.conversationMode}
- Last referenced product: ${context.lastReferencedProductId || 'none'}
- Candidate products available: ${context.candidateProductIds?.length || 0}
- Recent conversation: ${context.recentMessages.slice(-3).join(' | ')}

Respond with JSON:
{
  "intent": "INTENT_NAME",
  "confidence": 0.0-1.0,
  "detectedProductName": "product name mentioned or null",
  "quantity": number or null,
  "addressText": "full address or null",
  "addressConfidence": 0.0-1.0,
  "candidates": [
    {"intent": "INTENT_NAME", "confidence": 0.0-1.0}
  ]
}`;
};

const normalizeIntent = (raw: string): ConversationIntent => {
  const normalized = (raw || '').trim().toUpperCase();

  const validIntents = Object.values(ConversationIntent);
  if (validIntents.includes(normalized as ConversationIntent)) {
    return normalized as ConversationIntent;
  }

  return ConversationIntent.UNKNOWN;
};

const normalizeCandidates = (
  candidates: unknown
): Array<{ intent: ConversationIntent; confidence: number }> => {
  if (!Array.isArray(candidates)) return [];

  return candidates
    .map((candidate) => {
      const candidateObj = candidate as { intent?: string; confidence?: number };
      return {
        intent: normalizeIntent(candidateObj.intent || ''),
        confidence:
          typeof candidateObj.confidence === 'number' ? candidateObj.confidence : 0
      };
    })
    .filter((candidate) => candidate.intent !== ConversationIntent.UNKNOWN)
    .sort((a, b) => b.confidence - a.confidence);
};

const DIRECT_THRESHOLD = 0.55;
const RESCUE_THRESHOLD = 0.45;

/** Diferencia mínima entre el 1.er y 2.º candidato para aceptar la intención sin confirmación. */
export const MIN_MARGIN = 0.15;

/**
 * Hay al menos dos candidatos y el margen entre el primero y el segundo es menor que {@link MIN_MARGIN}:
 * conviene pedir confirmación explícita al usuario.
 */
export function shouldAskIntentConfirmation(
  detection: IntentDetectionResult
): boolean {
  if (!detection.candidates || detection.candidates.length < 2) {
    return false;
  }
  const margin = detection.rescueMargin;
  if (margin == null) {
    return false;
  }
  return margin < MIN_MARGIN;
}

const resolveFinalIntent = (
  intent: ConversationIntent,
  confidence: number,
  candidates: Array<{ intent: ConversationIntent; confidence: number }>
): {
  intent: ConversationIntent;
  source: 'direct' | 'rescued' | 'unknown';
  topCandidate: { intent: ConversationIntent; confidence: number } | null;
  margin: number | null;
} => {
  if (intent !== ConversationIntent.UNKNOWN && confidence >= DIRECT_THRESHOLD) {
    return {
      intent,
      source: 'direct',
      topCandidate: candidates[0] || null,
      margin:
        candidates.length >= 2
          ? candidates[0].confidence - candidates[1].confidence
          : null
    };
  }

  const topCandidate = candidates[0];
  const secondCandidate = candidates[1];
  const margin =
    topCandidate && secondCandidate
      ? topCandidate.confidence - secondCandidate.confidence
      : topCandidate
        ? topCandidate.confidence
        : null;

  if (
    intent === ConversationIntent.UNKNOWN &&
    topCandidate &&
    topCandidate.confidence >= RESCUE_THRESHOLD &&
    (margin ?? 0) >= MIN_MARGIN
  ) {
    return {
      intent: topCandidate.intent,
      source: 'rescued',
      topCandidate,
      margin
    };
  }

  return {
    intent: intent === ConversationIntent.UNKNOWN ? ConversationIntent.UNKNOWN : intent,
    source: intent === ConversationIntent.UNKNOWN ? 'unknown' : 'direct',
    topCandidate: topCandidate || null,
    margin
  };
};

const extractQuantityFromText = (text: string): number | null => {
  // Números explícitos
  const numberMatch = text.match(/\b(\d+)\b/);
  if (numberMatch) {
    const num = parseInt(numberMatch[1], 10);
    if (num > 0 && num < 100) return num;
  }

  // Palabras en español
  const wordMap: Record<string, number> = {
    'uno': 1, 'una': 1, 'un': 1,
    'dos': 2,
    'tres': 3,
    'cuatro': 4,
    'cinco': 5,
    'seis': 6,
    'siete': 7,
    'ocho': 8,
    'nueve': 9,
    'diez': 10
  };

  const lowerText = text.toLowerCase();
  for (const [word, num] of Object.entries(wordMap)) {
    if (lowerText.includes(word)) return num;
  }

  return null;
};

/**
 * Mención de comida/ingrediente genérico → prioridad PRODUCT_QUERY sobre VIEW_MENU.
 * Lista ampliable; coincide con platos típicos y variantes en español.
 */
const LOOSE_FOOD_PATTERN =
  /\b(pollo|carne|pescado|cerdo|vac(a|o|ío)|hamburguesa|pizza|pasta|ensalada|postres?|tarta|empanada[s]?|asado|milanesa|ñoquis|ravioles|sándwich|sandwich|ceviche|sushi|tacos?|burrito|verdura[s]?|vegetariano|vegano|bebida[s]?|gaseosa|cerveza|vino|café|helado|guiso|sopa|milanesas?)\b/i;

function hasLooseFoodTopic(text: string): boolean {
  return LOOSE_FOOD_PATTERN.test(text);
}

function extractLooseFoodKeyword(text: string): string | null {
  const m = text.match(LOOSE_FOOD_PATTERN);
  return m ? m[0].trim().toLowerCase() : null;
}

/**
 * Pedido explícito de catálogo sin ingrediente concreto (VIEW_MENU legítimo).
 * Si el texto nombra comida, debe devolver false para no bloquear PRODUCT_QUERY.
 */
function isExplicitMenuOnlyRequest(text: string): boolean {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (t.length <= 28 && /^(qu[eé]|que)\s+tienen\??$/.test(t)) return true;
  if (/\bmostrar\s+(las\s+)?categor/i.test(t)) return true;
  if (/\bver\s+(las\s+)?categor/i.test(t)) return true;
  if (
    /\b(ver|mostrar|mostrame|mostrá)\s+(el\s+)?(menú|menu)\b/.test(t) &&
    !hasLooseFoodTopic(t)
  ) {
    return true;
  }
  if (/\bcat[aá]logo\b/.test(t) && !hasLooseFoodTopic(t)) return true;
  return false;
}

const INTENTS_BLOCK_FORCE_PRODUCT_QUERY: ReadonlySet<ConversationIntent> = new Set([
  ConversationIntent.REMOVE_ITEM,
  ConversationIntent.MODIFY_QUANTITY,
  ConversationIntent.PRODUCT_ATTRIBUTE_QUESTION,
  ConversationIntent.VIEW_CART,
  ConversationIntent.VIEW_CART_FOR_EDITION,
  ConversationIntent.RESERVATION,
  ConversationIntent.EDIT_ADDRESS,
  ConversationIntent.CHECKOUT,
  ConversationIntent.CANCEL_ORDER
]);

/**
 * PRODUCT_QUERY > VIEW_MENU: si hay producto detectado o mención de comida, forzar búsqueda/recomendación.
 */
function applyProductQueryPriorityRules(params: {
  message: string;
  intent: ConversationIntent;
  detectedProductName: string | null;
}): { intent: ConversationIntent; detectedProductName: string | null } {
  const { message, intent } = params;
  let name = params.detectedProductName?.trim() || null;

  if (!name && hasLooseFoodTopic(message) && !isExplicitMenuOnlyRequest(message)) {
    name = extractLooseFoodKeyword(message);
  }

  if (!name) {
    return {
      intent,
      detectedProductName: params.detectedProductName?.trim() || null
    };
  }

  if (INTENTS_BLOCK_FORCE_PRODUCT_QUERY.has(intent)) {
    return { intent, detectedProductName: name };
  }

  return {
    intent: ConversationIntent.PRODUCT_QUERY,
    detectedProductName: name
  };
}

/** Indica que el número se refiere a personas/comensales, no a ítems. */
const hasPartySizeContext = (text: string): boolean => {
  const lower = text.toLowerCase();
  if (/\b(personas?|comensales?)\b/.test(lower)) return true;
  if (/\bsomos\b/.test(lower) && /\b(un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|\d+)\b/.test(lower))
    return true;
  return false;
};

/** Quiere abrir flujo de pedido o ver menú/catálogo (no una consulta puntual de producto). */
const wantsMenuOrOpenOrderFlow = (text: string): boolean =>
  /(menú|menu|\bpedido\b|orden(ar|á|amos)?|hacer\s+(un\s+)?pedido|quiero\s+(pedir|hacer)|mostrar(me)?\s+(el\s+)?(menú|menu)|ver\s+(el\s+)?(menú|menu)|cat[aá]logo|empez(ar|á|amos)\s+(a\s+)?(pedir|ordenar))/i.test(
    text
  );

const looksLikeReservationIntent = (text: string): boolean =>
  /\b(reserva|reservar|mesa\s+para|booking|book\s+a\s+table)\b/i.test(text);

/**
 * Si el modelo confunde saludo/pedido genérico con headcount, forzar VIEW_MENU + quantity.
 * No aplica si hay nombre de producto o mención de comida (flujo PRODUCT_QUERY / recomendaciones).
 */
const applyViewMenuPartyIntentOverride = (params: {
  message: string;
  intent: ConversationIntent;
  quantity: number | null;
  parsedConfidence: number;
  detectedProductName: string | null;
}): {
  intent: ConversationIntent;
  quantity: number | null;
  confidence: number;
} => {
  const { message, intent, parsedConfidence, detectedProductName } = params;
  let { quantity } = params;

  if (detectedProductName?.trim()) {
    return { intent, quantity, confidence: parsedConfidence };
  }

  if (hasLooseFoodTopic(message) && !isExplicitMenuOnlyRequest(message)) {
    return { intent, quantity, confidence: parsedConfidence };
  }

  const eligible =
    intent === ConversationIntent.ORDER_FOOD ||
    intent === ConversationIntent.SMALL_TALK ||
    intent === ConversationIntent.UNKNOWN;

  if (!eligible) {
    return { intent, quantity, confidence: parsedConfidence };
  }

  if (looksLikeReservationIntent(message)) {
    return { intent, quantity, confidence: parsedConfidence };
  }

  if (!hasPartySizeContext(message) || !wantsMenuOrOpenOrderFlow(message)) {
    return { intent, quantity, confidence: parsedConfidence };
  }

  const q = quantity ?? extractQuantityFromText(message);
  if (q == null || q <= 0) {
    return { intent, quantity, confidence: parsedConfidence };
  }

  const confidence =
    intent === ConversationIntent.UNKNOWN
      ? Math.max(parsedConfidence, 0.72)
      : parsedConfidence;

  return {
    intent: ConversationIntent.VIEW_MENU,
    quantity: q,
    confidence
  };
};