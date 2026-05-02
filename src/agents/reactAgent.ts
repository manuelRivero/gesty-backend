/**
 * Hybrid ReAct agent (fase 2).
 *
 * Sólo se invoca cuando `AGENT_MODE=hybrid` y el intent detectado por
 * `detectIntentWithConfidence` es uno de los abiertos:
 * `ORDER_FOOD`, `PRODUCT_QUERY`, `PRODUCT_ATTRIBUTE_QUESTION` o `UNKNOWN`.
 * `RECOMMENDATION_REQUEST` queda fuera a propósito (ver nota en `dispatch/index.ts`).
 *
 * El agente recibe el `EnrichedContext` (business + customer + conversation +
 * mensaje) en su HumanMessage, y un set de tools de **lectura** (`tools/index.ts`)
 * para inspeccionar menú, carrito y horarios. La respuesta final del agente
 * (último `AIMessage`) se traduce a un `HandlerResult` plano (texto), igual a
 * lo que produciría `FallbackHandler` en modo determinístico.
 *
 * Pipeline CTA (cuando HYBRID_CTA_ENABLED=true):
 *  texto ReAct → ctaPlanner (LLM) → ctaResolver (determinístico) → buildHybridCtaInteractive
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { HumanMessage } from '@langchain/core/messages';
import { getReactReasonerLlm } from '../config/llm';
import { allReactTools } from '../tools';
import type { EnrichedContext, HandlerResult } from '../controllers/webhook/types';
import { formatBotUserMessage, normalizeMetadata } from '../services/productQuery/utils';
import {
  isHybridCtaEnabled,
  getHybridCtaTargetIntents,
  isHybridCtaEnabledForBusiness,
} from '../config/env';
import { planCta } from './ctaPlanner';
import { resolveCta } from './ctaResolver';
import {
  buildHybridCtaInteractive,
  extractPrimaryPayload,
  extractPrimaryProductId,
} from '../whatsappBuilders/hybridCta';
import { patchConversationMetadata } from '../repositories';
import { MenuService } from '../services/menu.service';
import type { CtaPlannerInput } from './types';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Mínima confianza de detección para intentar mostrar CTA. */
const MIN_CTA_CONFIDENCE = 0.6;

/** Ventana de cooldown en ms (5 minutos = 1-2 turnos típicos). */
const CTA_COOLDOWN_MS = 5 * 60 * 1000;

/** Máximo de caracteres en el texto del bot para mostrar CTA. */
const MAX_TEXT_FOR_CTA = 600;

/** Número de productos del menú a precargar como contexto para el planner. */
const TOP_MENU_PRODUCTS_FOR_PLANNER = 5;

let cachedAgent: ReturnType<typeof createReactAgent> | null = null;

const buildAgent = () => {
  if (!cachedAgent) {
    cachedAgent = createReactAgent({
      llm: getReactReasonerLlm(),
      tools: allReactTools,
      prompt: HYBRID_AGENT_SYSTEM_PROMPT,
    });
  }
  return cachedAgent;
};

/** Solo para uso en tests: resetea el singleton del ReAct agent. */
export const resetAgentCacheForTesting = (): void => {
  cachedAgent = null;
};

const HYBRID_AGENT_SYSTEM_PROMPT = `Sos el asistente conversacional de un restaurante atendiendo por WhatsApp.
Para el cliente vos sos el ÚNICO bot — nunca menciones otro sistema, "bot oficial", "asistente principal" ni nada parecido.

REGLAS DURAS:
- Respondé SIEMPRE en español rioplatense, breve y amable.
- Sólo respondé sobre el negocio actual (menú, horarios, carrito).
- TOOL-FIRST OBLIGATORIO: antes de mencionar cualquier nombre de plato, ingrediente, precio, horario o estado del carrito DEBÉS haber invocado la tool correspondiente en este mismo turno y citar EXACTAMENTE lo que esa tool devolvió. Está prohibido inventar nombres, precios, descripciones o disponibilidad.
- Si la tool no devuelve el producto/dato que el cliente pidió, decilo de forma directa ("no lo tenemos cargado") y, si corresponde, ofrecé alternativas que SÍ existan (verificadas por tool).
- ANTI-MULTI-PRODUCTO: si vas a hablar de 2 o más platos, NO los enumeres por nombre en el texto. Escribí solamente una invitación corta (1-2 oraciones) describiendo el tipo de opciones; el sistema agrega abajo la lista interactiva con los nombres y permite elegir uno. Si vas a hablar de UN solo plato, ahí sí podés nombrarlo y describirlo.
- NO MENCIONES BOTONES NI UI: nunca digas "tocá el botón", "elegí de la lista de abajo", "usá los botones del bot" ni similares. Otro componente del sistema agrega la UI cuando corresponde — vos sólo escribís el texto. Si no podés ejecutar una acción transaccional (agregar al carrito, pagar, reservar), describí cuál sería el próximo paso de forma neutral ("para sumarlo al pedido seguís desde acá") sin prometer botones específicos.

TOOLS DISPONIBLES:
- search_products(keyword): busca productos en el menú por similitud semántica (nombre o ingrediente). Devuelve shortlist liviano.
- find_products_by_filter(categoryTag?, categoryId?, containsIngredient?, excludesIngredient?, minServesPeople?, minPrice?, maxPrice?, currencyCode?, featuredOnly?, limit?): busca productos con filtros estructurados. Usar cuando el cliente describe un criterio en vez de un nombre (ej. "algo vegetariano", "para 4 personas", "menos de $5000", "sin tacc"). Devuelve shortlist liviano.
- get_products_details_by_ids(productIds, currencyCode?): trae detalle completo SOLO para productos ya shortlistados (descripcion, ingredientes, porciones y precio activo).
- check_product_availability(productId? | productName?): confirma si un producto puntual está disponible AHORA. Llamar SIEMPRE antes de prometer un plato concreto al cliente.
- get_featured_products(currencyCode?, limit?): lista productos destacados (recomendaciones).
- get_complementary_suggestions(productId? | categoryTag?, limit?): productos que combinan con un plato base. Usar para "¿qué le va bien a X?".
- get_categories(): lista categorías.
- get_menu_by_category(categoryId): items por categoría.
- get_cart(): carrito activo (snapshot, no modifica nada).
- get_business_hours(): si está abierto y horarios.
- get_business_info(): nombre, descripción, ubicación (lat/lng + mapsUrl), zona horaria, moneda y teléfono. Usar para "¿dónde están?", "¿cómo se llaman?", "¿en qué moneda cobran?".
- get_recent_messages(take?): últimos mensajes de la conversación.

POLITICA DE CONTEXTO (IMPORTANTE):
- Cuando busques productos, primero pedi shortlist (search_products/find_products_by_filter) y NO enumeres demasiados items en el texto.
- Si necesitás más detalle, hidratá solo 1-3 ids con get_products_details_by_ids.
- Evitá pedir grandes volúmenes en una sola llamada.

FORMATO DE SALIDA:
- Devolvé EXCLUSIVAMENTE texto para WhatsApp. Nunca JSON ni objetos (ej.: nunca {"text":"..."}).
- Usá este estilo visual para que se vea prolijo:
  - Primera línea: 🤖
  - Segunda sección: un título corto e importante en negrita con un emoji (ej.: *Recomendación* 🍽️)
  - Luego el mensaje en 1-3 párrafos cortos, escaneables.
- Resaltá datos importantes con *negrita* (nombres de platos, precios, horarios) — recordá que sólo podés escribir nombres/precios verificados por tool.
- Evitá markdown pesado, tablas y bloques de código.
- Máximo ~600 caracteres salvo que el usuario pida un detalle largo.`;

const buildContextMessage = (ctx: EnrichedContext): string => {
  return ctx.message?.text?.body ?? '';
};

const extractFinalText = (result: unknown): string | null => {
  if (typeof result !== 'object' || result === null) return null;
  const messages = (result as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1] as { content?: unknown };
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return (
      last.content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (typeof part === 'object' && part && 'text' in part) {
            return String((part as { text: unknown }).text ?? '');
          }
          return '';
        })
        .join('')
        .trim() || null
    );
  }
  return null;
};

const ensureWhatsAppBotFormat = (text: string): string => {
  const normalized = text.trim();
  if (!normalized) return normalized;
  if (normalized.startsWith('🤖')) return normalized;
  return formatBotUserMessage('Respuesta', '💬', normalized);
};

/** Guard transitorio: alerta si el LLM devuelve JSON pese al prompt de texto plano. Borrar tras 0 ocurrencias en producción por 1 semana. */
const guardJsonRegression = (rawText: string, conversationId: string): void => {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;
  try {
    JSON.parse(trimmed);
    console.warn(
      JSON.stringify({
        event: '[regression] llm_returned_json_despite_plaintext_prompt',
        rawTextPreview: trimmed.slice(0, 200),
        conversationId,
      })
    );
  } catch {
    /* not JSON — all good */
  }
};

// ---------------------------------------------------------------------------
// Cooldown helpers
// ---------------------------------------------------------------------------

const isCtaCooldownActive = (metadata: ReturnType<typeof normalizeMetadata>): boolean => {
  const shownAt = metadata.lastCtaShownAt;
  if (!shownAt) return false;
  const elapsed = Date.now() - new Date(shownAt).getTime();
  return elapsed < CTA_COOLDOWN_MS;
};

// ---------------------------------------------------------------------------
// CTA pipeline pre-checks
// ---------------------------------------------------------------------------

/** Devuelve la razón por la que NO se debe mostrar CTA, o `null` si puede proceder. */
const ctaSkipReason = (params: {
  text: string;
  intent: string;
  confidence: number;
  metadata: ReturnType<typeof normalizeMetadata>;
  businessId: string;
}): string | null => {
  const { text, intent, confidence, metadata, businessId } = params;

  if (!isHybridCtaEnabled()) return 'feature_off';
  if (!isHybridCtaEnabledForBusiness(businessId)) return 'feature_off';
  if (!getHybridCtaTargetIntents().has(intent)) return 'intent_not_target';
  if (confidence < MIN_CTA_CONFIDENCE) return 'low_confidence';
  if (text.length > MAX_TEXT_FOR_CTA) return 'text_too_long';
  if (isCtaCooldownActive(metadata)) return 'cooldown';
  return null;
};

// ---------------------------------------------------------------------------
// Menu pre-fetch for planner context
// ---------------------------------------------------------------------------

const prefetchTopMenuProducts = async (params: {
  businessId: string;
  keyword: string | null;
}): Promise<string[]> => {
  if (!params.keyword || !params.keyword.trim()) return [];
  try {
    const results = await MenuService.searchMenuItemsByKeyword({
      businessId: params.businessId,
      keyword: params.keyword,
    });
    return results.slice(0, TOP_MENU_PRODUCTS_FOR_PLANNER).map((r) => r.name);
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Ejecuta el ReAct agent. Si el agente no produce texto utilizable, devuelve
 * `null` para que el caller (nodo `nlpSubgraph` en modo hybrid) caiga al
 * handler determinístico.
 *
 * Si HYBRID_CTA_ENABLED=true y el intent es target, ejecuta el pipeline CTA
 * post-ReAct y devuelve un HandlerResult interactivo cuando aplica.
 */
export const runHybridReactAgent = async (
  ctx: EnrichedContext
): Promise<HandlerResult | null> => {
  const agent = buildAgent();

  const businessId =
    typeof ctx.business === 'object' && ctx.business
      ? (ctx.business as { id: string }).id
      : '';
  const customerId =
    typeof ctx.customer === 'object' && ctx.customer
      ? (ctx.customer as { id: string }).id
      : '';
  const customerPhone =
    typeof ctx.customer === 'object' && ctx.customer
      ? (ctx.customer as { phone_number?: string }).phone_number ?? ctx.to
      : ctx.to;
  const conversationId = ctx.conversationId;
  const conversationStartedAt =
    typeof ctx.conversation === 'object' && ctx.conversation
      ? (ctx.conversation as { started_at?: Date }).started_at?.toISOString() ?? ''
      : '';

  const inputs = {
    messages: [new HumanMessage(buildContextMessage(ctx))],
  };

  const out = await agent.invoke(inputs, {
    recursionLimit: 8,
    configurable: { businessId, customerId, customerPhone, conversationId, conversationStartedAt },
  });
  const rawText = extractFinalText(out);
  if (!rawText) return null;

  guardJsonRegression(rawText, ctx.conversationId);

  const formattedText = ensureWhatsAppBotFormat(rawText);
  const userMessage = ctx.message?.text?.body ?? '';

  // --- CTA pipeline ---
  const intent = ctx.detection.intent as string;
  const confidence = ctx.detection.confidence;
  const detectedProductName = ctx.detection.detectedProductName;
  const lastReferencedProductId =
    (ctx.conversation as { lastReferencedProductId?: string | null }).lastReferencedProductId ??
    null;

  const metadata = normalizeMetadata(ctx.conversationState?.metadata);

  const skipReason = ctaSkipReason({ text: formattedText, intent, confidence, metadata, businessId });

  if (skipReason) {
    console.log(
      JSON.stringify({ event: '[hybrid-cta] cta_skipped', intent, reason: skipReason, conversationId })
    );
    return { content: formattedText, isInteractive: false };
  }

  const topMenuProductNames = await prefetchTopMenuProducts({
    businessId,
    keyword: detectedProductName,
  });

  const lastReferencedProductName = metadata.lastReferencedProductName ?? null;

  const plannerInput: CtaPlannerInput = {
    botResponseText: formattedText,
    intent,
    detectedProductName,
    lastReferencedProductName,
    userMessage,
    topMenuProductNames,
  };

  const plannerStart = Date.now();
  const plannerRaw = await planCta(plannerInput);
  const plannerLatencyMs = Date.now() - plannerStart;

  console.log(
    JSON.stringify({
      event: '[hybrid-cta] cta_evaluated',
      intent,
      hadText: true,
      plannerResult: plannerRaw ? 'plan' : 'null',
      plannerLatencyMs,
      conversationId,
    })
  );

  if (!plannerRaw) {
    return { content: formattedText, isInteractive: false };
  }

  const resolvedPlan = await resolveCta({
    plannerRaw,
    businessId,
    lastReferencedProductId,
    detectedProductName,
    botResponseText: formattedText,
    detectionQuantity: ctx.detection.quantity,
    userMessage,
  });

  const handlerResult = buildHybridCtaInteractive(formattedText, resolvedPlan);

  if (!handlerResult) {
    return { content: formattedText, isInteractive: false };
  }

  const primaryPayload = extractPrimaryPayload(resolvedPlan);
  const primaryProductId = extractPrimaryProductId(resolvedPlan);

  try {
    await patchConversationMetadata(conversationId, {
      lastCtaShownAt: new Date().toISOString(),
      ...(primaryProductId ? { lastCtaProductId: primaryProductId } : {}),
      ...(primaryPayload ? { lastCtaPayload: primaryPayload } : {}),
    });
  } catch (err) {
    console.error('[hybrid-cta] patchConversationMetadata failed:', err);
  }

  console.log(
    JSON.stringify({
      event: '[hybrid-cta] cta_shown',
      intent,
      primaryKind: resolvedPlan.primary.kind,
      productId: primaryProductId,
      hadSecondary: !!resolvedPlan.secondary,
      conversationId,
    })
  );

  return handlerResult;
};
