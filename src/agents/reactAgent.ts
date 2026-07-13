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
import { buildAgentHistoryMessages } from './conversationHistory';
import { buildHybridAgentSystemPrompt } from '../prompts/botPersonality';
import { resolvePersonalityForBusiness } from '../services/botPersonality.service';
import { allReactTools } from '../tools';
import type { EnrichedContext, HandlerFollowUp, HandlerResult } from '../controllers/webhook/types';
import { buildListMessage, formatBotUserMessage, getRequestedPartySize, normalizeMetadata } from '../services/productQuery/utils';
import { prisma } from '../lib/prisma';
import {
  isHybridCtaEnabled,
  getHybridCtaTargetIntents,
  isHybridCtaEnabledForBusiness,
  isCheckoutAgentEnabled,
} from '../config/env';
import { planCta } from './ctaPlanner';
import { resolveCta } from './ctaResolver';
import {
  buildHybridCtaInteractive,
  extractPrimaryPayload,
  extractPrimaryProductId,
} from '../whatsappBuilders/hybridCta';
import { patchConversationMetadata } from '../repositories';
import { startCheckoutSessionTool } from '../tools/checkout';
import { MenuService } from '../services/menu.service';
import { truncateDescription, truncateTitle } from '../whatsappBuilders';
import type { CtaPlannerInput, CtaPlan } from './types';
import {
  buildLastOfferContextLines,
  persistLastOffer,
} from '../services/lastOffer.service';
import { buildCartSummaryMessage } from '../services/cart.service';
import { AddressService } from '../services/address.service';
import {
  buildOrderCompletionContextLines,
  getOrderCompletionLedger,
  deriveOrderCompletionGoal,
  computeOrderCompletionPermission,
} from '../services/orderCompletionGoal.service';
import {
  buildReservationCompletionContextLines,
  getReservationCompletionLedger,
  hasReservationDraftInProgress,
  deriveReservationCompletionGoal,
  computeReservationCompletionPermission,
} from '../services/reservationCompletionGoal.service';
import { findActiveEnvironmentsByBusinessId } from '../repositories/reservation.repository';

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

let cachedAgents = new Map<string, ReturnType<typeof createReactAgent>>();

const buildAgent = (personalityId: string, personalityPrompt: string) => {
  const checkoutDelegation = isCheckoutAgentEnabled();
  const cacheKey = `${personalityId}:${checkoutDelegation ? 'checkout' : 'main'}`;
  let agent = cachedAgents.get(cacheKey);
  if (!agent) {
    const tools = checkoutDelegation
      ? [...allReactTools, startCheckoutSessionTool]
      : allReactTools;
    agent = createReactAgent({
      llm: getReactReasonerLlm(),
      tools,
      prompt: buildHybridAgentSystemPrompt(personalityPrompt, {
        checkoutDelegationEnabled: checkoutDelegation,
      }),
    });
    cachedAgents.set(cacheKey, agent);
  }
  return agent;
};

/** Solo para uso en tests: resetea el cache del ReAct agent. */
export const resetAgentCacheForTesting = (): void => {
  cachedAgents = new Map();
};

const buildContextMessage = async (ctx: EnrichedContext): Promise<string> => {
  const userMsg = ctx.message?.text?.body ?? '';
  const meta = normalizeMetadata(ctx.conversationState?.metadata);
  const partySize = getRequestedPartySize(meta);
  const checkoutActive = meta.checkout_active === true;

  const businessId =
    typeof ctx.business === 'object' && ctx.business
      ? (ctx.business as { id: string }).id
      : '';
  const customerPhone =
    typeof ctx.customer === 'object' && ctx.customer
      ? (ctx.customer as { phone_number?: string }).phone_number ?? ctx.to
      : ctx.to;

  let cartSummary = 'sin pedido activo';
  let fulfillmentType = 'no aplica (checkout gestiona entrega al finalizar)';
  let hasItems = false;

  if (businessId && customerPhone) {
    try {
      const draft = await prisma.draft_order.findFirst({
        where: {
          business_id: businessId,
          customer_phone: customerPhone,
          status: 'active',
        },
        select: {
          fulfillment_type: true,
          _count: { select: { draft_order_item: true } },
        },
      });
      if (draft) {
        const count = draft._count.draft_order_item;
        hasItems = count > 0;
        cartSummary = count > 0 ? `${count} ítem(s) en carrito` : 'carrito vacío';
        fulfillmentType = draft.fulfillment_type
          ? `${draft.fulfillment_type} (solo checkout puede cambiarlo)`
          : 'sin elegir — se define al finalizar en checkout';
      }
    } catch {
      /* el agente puede usar get_cart */
    }
  }

  const reservationDraft = meta.reservation_draft;
  const reservationAgentActive = meta.reservation_agent_active === true;
  const hasReservationDraft = hasReservationDraftInProgress(reservationDraft);
  let hasEnvironments = false;
  if (hasReservationDraft && businessId) {
    try {
      const environments = await findActiveEnvironmentsByBusinessId(businessId);
      hasEnvironments = environments.length > 0;
    } catch {
      /* si falla, se asume sin ambientes — solo afecta el texto del hint */
    }
  }

  const partySizeLine = partySize
    ? `${partySize} (guía de cantidad a pedir, NO filtro de serves_people)`
    : 'no informado — preguntar solo si el cliente consulta platos o pide comida en este turno';

  const detection = ctx.detection;
  const nlpHint = detection
    ? {
        intent: String(detection.intent),
        detectedProductName: detection.detectedProductName ?? null,
        quantity: detection.quantity ?? null,
      }
    : null;

  // ADR-0009: a lo sumo un Intent activo por turno. Con dos Goals derivados
  // (Fase 0 y Fase 1b) hace falta un arbitraje explícito: se calcula el
  // permiso puro de cada uno primero, y si ambos ganarían el turno, se
  // suprime uno antes de construir las líneas (evita consumir presupuesto
  // de ambos y mostrarle al modelo dos objetivos a la vez). Empate entre
  // Goals de igual presión ("reanudable"): gana COMPLETAR_PEDIDO — un pago
  // pendiente es más urgente que una reserva a futuro.
  const orderLedger = getOrderCompletionLedger(meta);
  const orderGoal = deriveOrderCompletionGoal({ hasItems, checkoutActive }, orderLedger);
  const orderPermission = computeOrderCompletionPermission(orderGoal, orderLedger);

  const reservationLedger = getReservationCompletionLedger(meta);
  const reservationGoal = deriveReservationCompletionGoal(
    { hasDraft: hasReservationDraft, reservationAgentActive },
    reservationLedger
  );
  const reservationPermission = computeReservationCompletionPermission(
    reservationGoal,
    reservationLedger
  );
  const suppressReservation = orderPermission.granted && reservationPermission.granted;

  const lines = [
    `- Personas para el pedido: ${partySizeLine}`,
    `- Carrito: ${cartSummary}`,
    `- Tipo de entrega: ${fulfillmentType}`,
    `- Sesión de checkout: ${checkoutActive ? 'activa' : 'inactiva'}`,
    ...buildLastOfferContextLines(meta, nlpHint),
    ...buildOrderCompletionContextLines({
      facts: { hasItems, checkoutActive },
      ledger: orderLedger,
      conversationId: ctx.conversationId,
    }),
    ...buildReservationCompletionContextLines({
      facts: { hasDraft: hasReservationDraft, reservationAgentActive },
      ledger: reservationLedger,
      conversationId: ctx.conversationId,
      suppressedBySaliency: suppressReservation,
      draft: reservationDraft,
      hasEnvironments,
    }),
  ];

  return `[ESTADO DEL CLIENTE]\n${lines.join('\n')}\n\n${userMsg}`;
};

const persistLastOfferFromCtaPlan = async (
  conversationId: string,
  plan: CtaPlan,
  productHint?: string | null
): Promise<void> => {
  if (plan.primary.kind !== 'ADD_ITEM') return;

  const { productId, quantity } = plan.primary;
  let productName = productHint?.trim() || plan.productHint?.trim() || '';

  if (!productName) {
    try {
      const row = await prisma.menu_item.findUnique({
        where: { id: productId },
        select: { name: true },
      });
      productName = row?.name?.trim() ?? '';
    } catch {
      productName = '';
    }
  }

  if (!productName) return;

  await persistLastOffer({
    conversationId,
    productId,
    productName,
    suggestedQuantity: quantity,
    source: 'hybrid_cta',
  });
};

// ---------------------------------------------------------------------------
// Señales del agente híbrido (delegación a checkout)
// ---------------------------------------------------------------------------

export interface HybridAgentSignals {
  startCheckoutSession: boolean;
  startCheckoutReason: string | null;
  presentCart: boolean;
  presentAddressConfirmation: boolean;
  /** Texto normalizado de la última dirección dejada `in_coverage` por `stage_delivery_address` este turno. */
  stagedAddressText: string | null;
}

export type HybridAgentRunResult =
  | { kind: 'response'; handlerResult: HandlerResult }
  | { kind: 'delegate_checkout'; reason: string | null };

const extractHybridSignals = (messages: unknown[]): HybridAgentSignals => {
  const signals: HybridAgentSignals = {
    startCheckoutSession: false,
    startCheckoutReason: null,
    presentCart: false,
    presentAddressConfirmation: false,
    stagedAddressText: null,
  };

  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue;
    const m = msg as Record<string, unknown>;
    if (typeof m.tool_call_id !== 'string') continue;

    const rawContent = typeof m.content === 'string' ? m.content : null;
    if (!rawContent) continue;

    try {
      const data = JSON.parse(rawContent) as {
        signal?: string;
        reason?: string;
        status?: string;
        formattedAddress?: string;
      };
      if (data.signal === 'start_checkout_session') {
        signals.startCheckoutSession = true;
        signals.startCheckoutReason = data.reason ?? null;
      }
      if (data.signal === 'present_cart') {
        signals.presentCart = true;
      }
      if (data.signal === 'present_address_confirmation') {
        signals.presentAddressConfirmation = true;
      }
      if (m.name === 'stage_delivery_address' && data.status === 'in_coverage' && data.formattedAddress) {
        signals.stagedAddressText = data.formattedAddress;
      }
    } catch {
      /* ignorar mensajes no-JSON */
    }
  }

  return signals;
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
): Promise<HybridAgentRunResult | null> => {
  const businessId =
    typeof ctx.business === 'object' && ctx.business
      ? (ctx.business as { id: string }).id
      : '';
  if (!businessId) return null;

  const { id: personalityId, promptText } =
    await resolvePersonalityForBusiness(businessId);
  const agent = buildAgent(personalityId, promptText);

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

  const history = await buildAgentHistoryMessages({
    conversationId,
    startedAt:
      typeof ctx.conversation === 'object' && ctx.conversation
        ? (ctx.conversation as { started_at?: Date }).started_at ?? null
        : null,
    currentMessageId: ctx.message?.id ?? null,
  });

  const inputs = {
    messages: [...history, new HumanMessage(await buildContextMessage(ctx))],
  };

  const out = await agent.invoke(inputs, {
    recursionLimit: 8,
    configurable: { businessId, customerId, customerPhone, conversationId, conversationStartedAt },
  });

  const agentMessages = (out as { messages?: unknown[] }).messages ?? [];
  const signals = extractHybridSignals(agentMessages);

  if (signals.startCheckoutSession) {
    console.log(
      JSON.stringify({
        event: '[hybrid-agent] delegate_to_checkout',
        reason: signals.startCheckoutReason,
        conversationId,
      })
    );
    return {
      kind: 'delegate_checkout',
      reason: signals.startCheckoutReason,
    };
  }

  if (signals.presentCart) {
    try {
      const business = ctx.business as { id: string; currency_code?: string | null; street_address?: string | null };
      const customer = ctx.customer as { id: string };
      const cartMsg = await buildCartSummaryMessage({
        businessId,
        customerPhone,
        conversationId,
        customerId: customer.id,
        currencyCode: business.currency_code ?? null,
        businessStreetAddress: business.street_address ?? null,
      });
      console.log(JSON.stringify({ event: '[hybrid-agent] present_cart_signal', conversationId }));
      return { kind: 'response', handlerResult: markHybridResult({ content: cartMsg, isInteractive: true }) };
    } catch (err) {
      console.error('[hybrid-agent] present_cart failed, falling through', err);
    }
  }

  // Dirección compartida al responder una pregunta de envío delegada (ADR-0002):
  // `stage_delivery_address` ya la dejó pendiente de confirmación (`pending_address_*`
  // en metadata, ver AddressService); acá solo se construye la tarjeta. La confirmación
  // real (botón o texto libre) la resuelve `delegatedAddressConfirmationNode`, que
  // `context/index.ts` prioriza sobre cualquier otra sesión en el próximo turno.
  if (signals.presentAddressConfirmation && signals.stagedAddressText) {
    const confirmMsg = new AddressService().buildDelegatedConfirmAddressMessage(
      `📍 Encontré esta dirección:\n${signals.stagedAddressText}\n\n¿Es correcta?`
    );
    console.log(JSON.stringify({ event: '[hybrid-agent] present_address_confirmation_signal', conversationId }));
    return { kind: 'response', handlerResult: markHybridResult({ content: confirmMsg, isInteractive: true }) };
  }

  const rawText = extractFinalText(out);
  if (!rawText) return null;

  guardJsonRegression(rawText, ctx.conversationId);

  const formattedText = ensureWhatsAppBotFormat(rawText);
  const userMessage = ctx.message?.text?.body ?? '';

  // Extraer productos encontrados por tools de búsqueda para mostrarlo como lista interactiva.
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
        ctaSkipped: 'tool_shortlist_authoritative',
        conversationId,
      })
    );
    // La shortlist de las tools es autoritativa (IDs verificados). No competir con
    // CTA SELECT_FROM_LIST, que re-busca por nombre y puede desalinear candidateProductIds.
    return {
      kind: 'response',
      handlerResult: markHybridResult({
        content: formattedText,
        isInteractive: false,
        followUps: [productFollowUp],
      }),
    };
  }

  // --- CTA pipeline ---
  // Sin `detection` (turno delegado desde una sesión sin re-detección previa)
  // no hay intent/confidence confiables para planear un CTA: se degrada a
  // texto plano en vez de crashear (H-01).
  if (!ctx.detection) {
    console.log(
      JSON.stringify({ event: '[hybrid-cta] cta_skipped', reason: 'no_detection', conversationId: ctx.conversationId })
    );
    return {
      kind: 'response',
      handlerResult: markHybridResult({
        content: formattedText,
        isInteractive: false,
        ...(productFollowUp ? { followUps: [productFollowUp] } : {}),
      }),
    };
  }

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
    return {
      kind: 'response',
      handlerResult: markHybridResult({
        content: formattedText,
        isInteractive: false,
        ...(productFollowUp ? { followUps: [productFollowUp] } : {}),
      }),
    };
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
    listedProductNames: foundProducts.map((p) => p.name),
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
    return {
      kind: 'response',
      handlerResult: markHybridResult({
        content: formattedText,
        isInteractive: false,
        ...(productFollowUp ? { followUps: [productFollowUp] } : {}),
      }),
    };
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
    return {
      kind: 'response',
      handlerResult: markHybridResult({
        content: formattedText,
        isInteractive: false,
        ...(productFollowUp ? { followUps: [productFollowUp] } : {}),
      }),
    };
  }

  const primaryPayload = extractPrimaryPayload(resolvedPlan);
  const primaryProductId = extractPrimaryProductId(resolvedPlan);
  const selectListCandidateIds =
    resolvedPlan.primary.kind === 'SELECT_FROM_LIST'
      ? resolvedPlan.primary.candidates.map((c) => c.productId)
      : null;

  try {
    await patchConversationMetadata(conversationId, {
      lastCtaShownAt: new Date().toISOString(),
      ...(primaryProductId ? { lastCtaProductId: primaryProductId } : {}),
      ...(primaryPayload ? { lastCtaPayload: primaryPayload } : {}),
      ...(selectListCandidateIds
        ? {
            pendingProductSelection: true,
            pendingQuestion: userMessage,
            candidateProductIds: selectListCandidateIds,
          }
        : {}),
    });
    await persistLastOfferFromCtaPlan(
      conversationId,
      resolvedPlan,
      detectedProductName
    );
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

  return { kind: 'response', handlerResult: markHybridResult(handlerResult) };
};
