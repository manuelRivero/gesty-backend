/**
 * Hybrid ReAct agent (fase 2).
 *
 * Sólo se invoca cuando `AGENT_MODE=hybrid` y el intent detectado por
 * `detectIntentWithConfidence` no está en `CLOSED_INTENTS` del dispatch
 * (flujos transaccionales / handover humano como `SUPPORT`, menú, carrito, etc.).
 * Los intents abiertos típicos son `ORDER_FOOD`, `PRODUCT_QUERY`,
 * `PRODUCT_ATTRIBUTE_QUESTION` o `UNKNOWN`.
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
import { buildHybridAgentSystemPrompt } from '../prompts/botPersonality';
import { allReactTools } from '../tools';
import type { EnrichedContext, HandlerFollowUp, HandlerResult } from '../controllers/webhook/types';
import { buildListMessage, formatBotUserMessage, getRequestedPartySize, normalizeMetadata } from '../services/productQuery/utils';
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
import { truncateDescription, truncateTitle } from '../whatsappBuilders';
import type { CtaPlannerInput } from './types';

const markHybridResult = (result: HandlerResult): HandlerResult => ({
  ...result,
  skipBodyHumanization: true,
});

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
      prompt: buildHybridAgentSystemPrompt(),
    });
  }
  return cachedAgent;
};

/** Solo para uso en tests: resetea el singleton del ReAct agent. */
export const resetAgentCacheForTesting = (): void => {
  cachedAgent = null;
};

const buildContextMessage = (ctx: EnrichedContext): string => {
  const userMsg = ctx.message?.text?.body ?? '';
  const meta = normalizeMetadata(ctx.conversationState?.metadata);
  const partySize = getRequestedPartySize(meta);
  if (!partySize) return userMsg;
  // Aclaración crítica: party size es guía de CANTIDAD A PEDIR, no filtro de serves_people.
  // Sin esta aclaración el agente filtra con minServesPeople y descarta platos individuales.
  return `[Contexto de cantidad: el cliente quiere pedir para ${partySize} persona${partySize === 1 ? '' : 's'}. Esto es una guía de cuántas unidades sugerir, NO un filtro de minServesPeople — buscá todos los productos disponibles y luego sugerí la cantidad adecuada.]\n${userMsg}`;
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
// Product list extraction from agent tool results
// ---------------------------------------------------------------------------

const PRODUCT_LIST_TOOLS = new Set(['search_products', 'find_products_by_filter']);

interface AgentShortlistItem {
  id: string;
  name: string;
  price?: { amount: string; currency: string } | null;
  description?: string | null;
}

/** Extrae productos encontrados por tools de búsqueda del historial de mensajes del agente. */
const extractProductsFromAgentMessages = (messages: unknown[]): AgentShortlistItem[] => {
  const seen = new Set<string>();
  const result: AgentShortlistItem[] = [];

  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue;
    const m = msg as Record<string, unknown>;
    if (typeof m.tool_call_id !== 'string') continue;
    if (typeof m.name !== 'string' || !PRODUCT_LIST_TOOLS.has(m.name)) continue;

    const rawContent = typeof m.content === 'string' ? m.content : null;
    if (!rawContent) continue;

    try {
      const data = JSON.parse(rawContent) as { items?: AgentShortlistItem[] };
      if (!Array.isArray(data.items)) continue;
      for (const item of data.items) {
        if (typeof item.id !== 'string' || !item.id) continue;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        result.push(item);
      }
    } catch { /* skip bad JSON */ }
  }

  return result;
};

/** Construye un followUp de lista WhatsApp cuando el agente encontró ≥ 2 productos. */
const buildProductListFollowUp = (products: AgentShortlistItem[]): HandlerFollowUp | null => {
  if (products.length < 2) return null;

  const listMessage = buildListMessage({
    headerText: '',
    bodyText: formatBotUserMessage(
      'Opciones disponibles',
      '📋',
      'Seleccioná un producto para ver el detalle o sumarlo al pedido.'
    ),
    footerText: 'Elegí una opción',
    actionButtonLabel: 'Ver opciones',
    sections: [
      {
        title: 'Disponibles',
        rows: products.slice(0, 10).map((p) => {
          const priceStr = p.price?.amount
            ? `$${Number(p.price.amount).toLocaleString('es-AR')}`
            : null;
          return {
            id: `SELECT_PRODUCT:${p.id}`,
            title: truncateTitle((p.name || 'Producto').trim()),
            description: truncateDescription(priceStr ?? p.description ?? 'Ver detalle'),
          };
        }),
      },
    ],
  });

  return { type: 'list', listMessage };
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

  // Extraer productos encontrados por tools de búsqueda para mostrarlo como lista interactiva.
  const agentMessages = (out as { messages?: unknown[] }).messages ?? [];
  const foundProducts = extractProductsFromAgentMessages(agentMessages);
  const productFollowUp = buildProductListFollowUp(foundProducts);

  if (productFollowUp) {
    // Guardar los candidatos en el conversation state para que SELECT_PRODUCT handler
    // pueda validar la selección del usuario cuando clickea en la lista.
    try {
      await patchConversationMetadata(conversationId, {
        pendingProductSelection: true,
        pendingQuestion: userMessage || ctx.message?.text?.body || '',
        candidateProductIds: foundProducts.map((p) => p.id),
      });
    } catch (err) {
      console.error('[hybrid-agent] failed to patch candidateProductIds:', err);
    }
    console.log(
      JSON.stringify({
        event: '[hybrid-agent] product_list_followup',
        productCount: foundProducts.length,
        conversationId,
      })
    );
  }

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
    return markHybridResult({
      content: formattedText,
      isInteractive: false,
      ...(productFollowUp ? { followUps: [productFollowUp] } : {}),
    });
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
    return markHybridResult({
      content: formattedText,
      isInteractive: false,
      ...(productFollowUp ? { followUps: [productFollowUp] } : {}),
    });
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
    return markHybridResult({
      content: formattedText,
      isInteractive: false,
      ...(productFollowUp ? { followUps: [productFollowUp] } : {}),
    });
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

  // CTA ya maneja la selección de producto; no duplicar la lista.
  return markHybridResult(handlerResult);
};
