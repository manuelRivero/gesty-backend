/**
 * Hybrid ReAct agent (fase 2).
 *
 * Sólo se invoca cuando `AGENT_MODE=hybrid` y el intent detectado por
 * `detectIntentWithConfidence` es uno de los abiertos:
 * `ORDER_FOOD`, `PRODUCT_QUERY`, `PRODUCT_ATTRIBUTE_QUESTION` o `UNKNOWN`.
 * `RECOMMENDATION_REQUEST` queda fuera a propósito (ver nota en `dispatch/index.ts`).
 *
 * El agente recibe el `EnrichedContext` (business + customer + conversation +
 * mensaje) en su SystemMessage, y un set de tools de **lectura** (`tools/index.ts`)
 * para inspeccionar menú, carrito y horarios. La respuesta final del agente
 * (último `AIMessage`) se traduce a un `HandlerResult` plano (texto), igual a
 * lo que produciría `FallbackHandler` en modo determinístico.
 *
 * Pipeline CTA (cuando HYBRID_CTA_ENABLED=true):
 *  texto ReAct → ctaPlanner (LLM) → ctaResolver (determinístico) → buildHybridCtaInteractive
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getReasonerLlm } from '../config/llm';
import { allReactTools } from '../tools';
import type { EnrichedContext, HandlerResult } from '../controllers/webhook/types';
import { formatBotUserMessage } from '../services/productQuery/utils';
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
import { buildListMessageFromButtons, truncateDescription, truncateTitle } from '../whatsappBuilders';
import { normalizeMetadata } from '../services/productQuery/utils';
import { patchConversationMetadata, findOrCreateConversationState } from '../repositories';
import { MenuService } from '../services/menu.service';
import type { CtaPlannerInput } from './types';
import { AgentOutputSchema, type AgentOutput } from './outputContract';
import { getSmallChatLlm } from '../config/llm';

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
const MAX_LIST_TITLE_LENGTH = 24;
const MAX_LIST_DESCRIPTION_LENGTH = 60;

let cachedAgent: ReturnType<typeof createReactAgent> | null = null;

const buildAgent = () => {
  if (!cachedAgent) {
    cachedAgent = createReactAgent({
      llm: getReasonerLlm(),
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
- search_products(businessId, keyword): busca productos en el menú por similitud semántica (nombre o ingrediente).
- find_products_by_filter(businessId, categoryTag?, categoryId?, containsIngredient?, excludesIngredient?, minServesPeople?, minPrice?, maxPrice?, currencyCode?, featuredOnly?, limit?): busca productos con filtros estructurados. Usar cuando el cliente describe un criterio en vez de un nombre (ej. "algo vegetariano", "para 4 personas", "menos de $5000", "sin tacc"). Solo devuelve disponibles.
- check_product_availability(businessId, productId? | productName?): confirma si un producto puntual está disponible AHORA. Llamar SIEMPRE antes de prometer un plato concreto al cliente.
- get_featured_products(businessId, currencyCode, limit): lista productos destacados (recomendaciones).
- get_complementary_suggestions(businessId, productId? | categoryTag?, limit?): productos que combinan con un plato base. Usar para "¿qué le va bien a X?".
- get_categories(businessId, customerId): lista categorías.
- get_menu_by_category(businessId, customerId, categoryId): items por categoría.
- get_cart(businessId, customerPhone): carrito activo (snapshot, no modifica nada).
- get_business_hours(businessId): si está abierto y horarios.
- get_business_info(businessId): nombre, descripción, ubicación (lat/lng + mapsUrl), zona horaria, moneda y teléfono. Usar para "¿dónde están?", "¿cómo se llaman?", "¿en qué moneda cobran?".
- get_recent_messages(conversationId, sinceStartedAt, take): últimos mensajes de la conversación.

CONTEXTO:
- El bloque [CONTEXT] del mensaje del usuario contiene el JSON con businessId, customerId, customerPhone, conversationId, conversationStartedAt y el texto que escribió el cliente.
- Usá esos identificadores en las tools que los necesiten.

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
  const text = ctx.message?.text?.body ?? '';

  return [
    '[CONTEXT]',
    JSON.stringify(
      {
        businessId,
        customerId,
        customerPhone,
        conversationId,
        conversationStartedAt,
      },
      null,
      0
    ),
    '',
    '[USER_MESSAGE]',
    text,
  ].join('\n');
};

const extractFinalText = (result: unknown): string | null => {
  if (typeof result !== 'object' || result === null) return null;
  const messages = (result as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1] as { content?: unknown };
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return last.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part === 'object' && part && 'text' in part) {
          return String((part as { text: unknown }).text ?? '');
        }
        return '';
      })
      .join('')
      .trim() || null;
  }
  return null;
};

const unwrapJsonTextEnvelope = (text: string): string => {
  const trimmed = text.trim().replace(/^'+|'+$/g, '');
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return trimmed;
  }
  try {
    const parsed = JSON.parse(trimmed) as { text?: unknown; content?: unknown };
    if (typeof parsed.text === 'string' && parsed.text.trim()) {
      return parsed.text.trim();
    }
    if (typeof parsed.content === 'string' && parsed.content.trim()) {
      return parsed.content.trim();
    }
  } catch {
    // Si no es JSON válido, se devuelve el texto original.
  }
  return trimmed;
};

const stripConsecutiveDuplicateLargeBlocks = (text: string): string => {
  const normalized = text.trim();
  if (!normalized) return normalized;

  const lines = normalized.split('\n');
  const deduped: string[] = [];

  for (const line of lines) {
    const current = line.trim();
    const prev = deduped.length > 0 ? deduped[deduped.length - 1].trim() : '';
    // Evita duplicados consecutivos de líneas "grandes" (caso típico: JSON repetido).
    if (current.length >= 120 && current === prev) {
      continue;
    }
    deduped.push(line);
  }

  return deduped.join('\n').trim();
};

const ensureWhatsAppBotFormat = (text: string): string => {
  const normalized = stripConsecutiveDuplicateLargeBlocks(
    unwrapJsonTextEnvelope(text)
  ).trim();
  if (!normalized) return normalized;
  if (normalized.startsWith('🤖')) {
    return normalized;
  }
  return formatBotUserMessage('Respuesta', '💬', normalized);
};

const STRUCTURED_OUTPUT_PROMPT = `Converti la respuesta del asistente a un JSON valido con UNO de estos modos:
- {"mode":"TEXT","text":"..."}
- {"mode":"LIST_CANDIDATES","introText":"...","items":[{"id":"...","title":"...","description":"..."}]}

Reglas:
- Devolve SOLO JSON valido, sin markdown ni texto extra.
- Usa LIST_CANDIDATES cuando haya multiples opciones de productos para elegir.
- En LIST_CANDIDATES, "id" debe ser el productId real (uuid) si esta disponible.
- Si no hay items accionables, usa TEXT.
- No repitas bloques JSON crudos en el texto.
- Mantene el idioma en espanol rioplatense.`;

const formatAgentOutput = async (params: {
  rawText: string;
  userMessage: string;
}): Promise<AgentOutput | null> => {
  const formatter = getSmallChatLlm().withStructuredOutput(AgentOutputSchema);

  try {
    return await formatter.invoke([
      new SystemMessage(STRUCTURED_OUTPUT_PROMPT),
      new HumanMessage(
        `Mensaje del usuario:\n${params.userMessage}\n\nRespuesta cruda del asistente:\n${params.rawText}`
      ),
    ]);
  } catch (error) {
    console.warn('[hybrid-agent] structured output formatting failed', error);
    return null;
  }
};

const mapStructuredOutputToHandlerResult = (
  output: AgentOutput
): HandlerResult | null => {
  if (output.mode === 'TEXT') {
    return {
      content: ensureWhatsAppBotFormat(output.text),
      isInteractive: false,
    };
  }

  const rows = output.items
    .map((item) => {
      const itemId = item.id.trim();
      const title = truncateTitle(item.title.trim(), MAX_LIST_TITLE_LENGTH);
      if (!itemId || !title) return null;
      return {
        title,
        payload: `SELECT_PRODUCT:${itemId}`,
        description: truncateDescription(
          (item.description ?? 'Selecciona esta opcion').trim(),
          MAX_LIST_DESCRIPTION_LENGTH
        ),
        sectionTitle: 'Opciones disponibles',
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));

  if (!rows.length) {
    return null;
  }

  rows.push({
    title: 'Ver menu completo',
    payload: 'VIEW_MENU',
    description: 'Explorar todas las categorias',
    sectionTitle: 'Navegacion',
  });

  return {
    content: buildListMessageFromButtons(
      ensureWhatsAppBotFormat(output.introText),
      rows,
      'Ver opciones',
      '',
      'Selecciona un producto'
    ),
    isInteractive: true,
  };
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

/**
 * Devuelve la razón por la que NO se debe mostrar CTA, o `null` si puede proceder.
 */
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
    return results
      .slice(0, TOP_MENU_PRODUCTS_FOR_PLANNER)
      .map((r) => r.name);
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

  const inputs = {
    messages: [
      new SystemMessage(HYBRID_AGENT_SYSTEM_PROMPT),
      new HumanMessage(buildContextMessage(ctx)),
    ],
  };

  const out = await agent.invoke(inputs);
  const rawText = extractFinalText(out);
  if (!rawText) return null;
  const userMessage = ctx.message?.text?.body ?? '';

  const structuredOutput = await formatAgentOutput({
    rawText,
    userMessage,
  });

  const structuredResult = structuredOutput
    ? mapStructuredOutputToHandlerResult(structuredOutput)
    : null;
  if (structuredResult?.isInteractive) {
    return structuredResult;
  }

  const formattedText =
    structuredOutput?.mode === 'TEXT'
      ? ensureWhatsAppBotFormat(structuredOutput.text)
      : ensureWhatsAppBotFormat(rawText);

  // --- CTA pipeline ---
  const businessId =
    typeof ctx.business === 'object' && ctx.business
      ? (ctx.business as { id: string }).id
      : '';
  const conversationId = ctx.conversationId;
  const intent = ctx.detection.intent as string;
  const confidence = ctx.detection.confidence;
  const detectedProductName = ctx.detection.detectedProductName;
  const lastReferencedProductId =
    (ctx.conversation as { lastReferencedProductId?: string | null })
      .lastReferencedProductId ?? null;

  const metadata = normalizeMetadata(ctx.conversationState?.metadata);

  const skipReason = ctaSkipReason({
    text: formattedText,
    intent,
    confidence,
    metadata,
    businessId,
  });

  if (skipReason) {
    console.log(
      JSON.stringify({
        event: '[hybrid-cta] cta_skipped',
        intent,
        reason: skipReason,
        conversationId,
      })
    );
    return { content: formattedText, isInteractive: false };
  }

  // Pre-fetch top menu products for planner context
  const topMenuProductNames = await prefetchTopMenuProducts({
    businessId,
    keyword: detectedProductName,
  });

  const lastReferencedProductName =
    typeof metadata === 'object'
      ? ((metadata as Record<string, unknown>).lastReferencedProductName as string | null | undefined) ??
        null
      : null;

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

  // Resolve productId deterministically
  const resolvedPlan = await resolveCta({
    plannerRaw,
    businessId,
    lastReferencedProductId,
    detectedProductName,
    botResponseText: formattedText,
    detectionQuantity: ctx.detection.quantity,
    userMessage,
  });

  // Build WhatsApp interactive message
  const handlerResult = buildHybridCtaInteractive(formattedText, resolvedPlan);

  if (!handlerResult) {
    // Builder failed → fallback to text
    return { content: formattedText, isInteractive: false };
  }

  // Persist CTA metadata for cooldown + click tracking
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
