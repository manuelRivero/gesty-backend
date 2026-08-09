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
 * CTA de producto: el agente llama `present_product_cta` si quiere botones/lista.
 * El runtime valida IDs y arma el interactive (sin CTA Planner post-proceso).
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { HumanMessage } from '@langchain/core/messages';
import { getReactReasonerLlm } from '../config/llm';
import { buildAgentHistoryMessages } from './conversationHistory';
import { buildContextMessage } from './contextMessage';
import { buildHybridAgentSystemPrompt } from '../prompts/botPersonality';
import { resolvePersonalityForBusiness } from '../services/botPersonality.service';
import { allReactTools } from '../tools';
import type { EnrichedContext, HandlerFollowUp, HandlerResult } from '../controllers/webhook/types';
import { buildListMessage, formatBotUserMessage } from '../services/productQuery/utils';
import { prisma } from '../lib/prisma';
import {
  isHybridCtaEnabled,
  isHybridCtaEnabledForBusiness,
  isCheckoutAgentEnabled,
} from '../config/env';
import { resolveCta } from './ctaResolver';
import {
  buildHybridCtaInteractive,
  extractPrimaryPayload,
  extractPrimaryProductId,
} from '../whatsappBuilders/hybridCta';
import { patchConversationMetadata } from '../repositories';
import { startCheckoutSessionTool } from '../tools/checkout';
import { truncateDescription, truncateTitle } from '../whatsappBuilders';
import type { CtaPlan, CtaPlannerRaw } from './types';
import { persistLastOffer } from '../services/lastOffer.service';
import { buildCartSummaryMessage } from '../services/cart.service';
import { AddressService } from '../services/address.service';
import { buildSmallTalkMenu } from '../services/smallTalk.service';

const markHybridResult = (result: HandlerResult): HandlerResult => ({
  ...result,
  skipBodyHumanization: true,
});

let cachedAgents = new Map<string, ReturnType<typeof createReactAgent>>();

/** Payload que emite la tool `present_product_cta`. */
export type PresentProductCtaSignal = {
  primaryKind: CtaPlannerRaw['primaryKind'];
  productHint: string | null;
  productHints: string[] | null;
  productId: string | null;
  quantity: number;
  primaryLabel: string | null;
  secondaryKind: CtaPlannerRaw['secondaryKind'];
  secondaryLabel: string | null;
};

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
  presentWelcomeOptions: boolean;
  welcomeBodyText: string | null;
  /** CTA de producto pedido explícitamente por el agente (tool present_product_cta). */
  presentProductCta: PresentProductCtaSignal | null;
}

export type HybridAgentRunResult =
  | { kind: 'response'; handlerResult: HandlerResult }
  | { kind: 'delegate_checkout'; reason: string | null };

const PRIMARY_KINDS = new Set(['ADD_ITEM', 'SELECT_FROM_LIST', 'VIEW_MENU', 'VIEW_FEATURED']);

const parsePresentProductCtaSignal = (data: Record<string, unknown>): PresentProductCtaSignal | null => {
  const primaryKind = data.primaryKind;
  if (typeof primaryKind !== 'string' || !PRIMARY_KINDS.has(primaryKind)) return null;

  const productHints = Array.isArray(data.productHints)
    ? data.productHints.filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
    : null;

  return {
    primaryKind: primaryKind as PresentProductCtaSignal['primaryKind'],
    productHint: typeof data.productHint === 'string' ? data.productHint : null,
    productHints: productHints && productHints.length > 0 ? productHints : null,
    productId: typeof data.productId === 'string' ? data.productId : null,
    quantity:
      typeof data.quantity === 'number' && Number.isFinite(data.quantity)
        ? Math.min(99, Math.max(1, Math.trunc(data.quantity)))
        : 1,
    primaryLabel: typeof data.primaryLabel === 'string' ? data.primaryLabel : null,
    secondaryKind:
      data.secondaryKind === 'VIEW_MENU' || data.secondaryKind === 'VIEW_FEATURED'
        ? data.secondaryKind
        : data.secondaryKind === null
          ? null
          : 'VIEW_FEATURED',
    secondaryLabel: typeof data.secondaryLabel === 'string' ? data.secondaryLabel : null,
  };
};

const defaultPrimaryLabel = (kind: PresentProductCtaSignal['primaryKind']): string => {
  switch (kind) {
    case 'ADD_ITEM':
      return 'Agregar 🛒';
    case 'SELECT_FROM_LIST':
      return 'Elegir uno 👇';
    case 'VIEW_FEATURED':
      return 'Ver destacados';
    default:
      return 'Ver menú';
  }
};

const extractHybridSignals = (messages: unknown[]): HybridAgentSignals => {
  const signals: HybridAgentSignals = {
    startCheckoutSession: false,
    startCheckoutReason: null,
    presentCart: false,
    presentAddressConfirmation: false,
    stagedAddressText: null,
    presentWelcomeOptions: false,
    welcomeBodyText: null,
    presentProductCta: null,
  };

  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue;
    const m = msg as Record<string, unknown>;
    if (typeof m.tool_call_id !== 'string') continue;

    const rawContent = typeof m.content === 'string' ? m.content : null;
    if (!rawContent) continue;

    try {
      const data = JSON.parse(rawContent) as Record<string, unknown> & {
        signal?: string;
        reason?: string;
        status?: string;
        formattedAddress?: string;
        bodyText?: string;
      };
      if (data.signal === 'start_checkout_session') {
        signals.startCheckoutSession = true;
        signals.startCheckoutReason = typeof data.reason === 'string' ? data.reason : null;
      }
      if (data.signal === 'present_cart') {
        signals.presentCart = true;
      }
      if (data.signal === 'present_address_confirmation') {
        signals.presentAddressConfirmation = true;
      }
      if (m.name === 'stage_delivery_address' && data.status === 'in_coverage' && data.formattedAddress) {
        signals.stagedAddressText = String(data.formattedAddress);
      }
      if (data.signal === 'present_welcome_options') {
        signals.presentWelcomeOptions = true;
        signals.welcomeBodyText = typeof data.bodyText === 'string' ? data.bodyText : null;
      }
      if (data.signal === 'present_product_cta') {
        const parsed = parsePresentProductCtaSignal(data);
        if (parsed) signals.presentProductCta = parsed;
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

  // Empuje proactivo en el primer saludo (objetivo primario del bot: no
  // quedarse en "¿en qué te ayudo?" abierto — ofrecer concretamente
  // menú/pedido/reserva). El body es el saludo propio del LLM (dado como
  // argumento de la tool, no el `text` final ya envuelto por
  // `ensureWhatsAppBotFormat` — evita duplicar el header "🤖").
  if (signals.presentWelcomeOptions) {
    try {
      const menu = await buildSmallTalkMenu(ctx, signals.welcomeBodyText ?? undefined);
      if (menu && typeof menu !== 'string') {
        console.log(JSON.stringify({ event: '[hybrid-agent] present_welcome_options_signal', conversationId }));
        return { kind: 'response', handlerResult: markHybridResult({ content: menu, isInteractive: true }) };
      }
    } catch (err) {
      console.error('[hybrid-agent] present_welcome_options failed, falling through', err);
    }
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

  // CTA solo si el agente pidió present_product_cta (sin planner post-proceso).
  if (
    signals.presentProductCta &&
    isHybridCtaEnabled() &&
    isHybridCtaEnabledForBusiness(businessId)
  ) {
    const ctaReq = signals.presentProductCta;
    const detectedProductName = ctx.detection?.detectedProductName ?? null;
    const lastReferencedProductId =
      (ctx.conversation as { lastReferencedProductId?: string | null }).lastReferencedProductId ??
      null;

    let resolvedPlan: CtaPlan | null = null;

    if (ctaReq.primaryKind === 'ADD_ITEM' && ctaReq.productId) {
      try {
        const row = await prisma.menu_item.findFirst({
          where: { id: ctaReq.productId, business_id: businessId, is_available: true },
          select: { id: true, name: true },
        });
        if (row) {
          resolvedPlan = {
            productHint: ctaReq.productHint ?? row.name,
            primary: {
              kind: 'ADD_ITEM',
              productId: row.id,
              quantity: ctaReq.quantity,
              label: (ctaReq.primaryLabel ?? defaultPrimaryLabel('ADD_ITEM')).slice(0, 20),
            },
            secondary: {
              kind: ctaReq.secondaryKind === 'VIEW_MENU' ? 'VIEW_MENU' : 'VIEW_FEATURED',
              label: (
                ctaReq.secondaryLabel ??
                (ctaReq.secondaryKind === 'VIEW_MENU' ? 'Ver menú' : 'Ver destacados')
              ).slice(0, 20),
            },
          };
        }
      } catch (err) {
        console.error('[hybrid-cta] productId lookup failed:', err);
      }
    }

    if (!resolvedPlan) {
      const plannerRaw: CtaPlannerRaw = {
        shouldShowCta: true,
        productHint: ctaReq.productHint,
        productHints: ctaReq.productHints,
        primaryKind: ctaReq.primaryKind,
        primaryLabel: ctaReq.primaryLabel ?? defaultPrimaryLabel(ctaReq.primaryKind),
        secondaryKind:
          ctaReq.secondaryKind ??
          (ctaReq.primaryKind === 'ADD_ITEM' ? 'VIEW_FEATURED' : null),
        secondaryLabel:
          ctaReq.secondaryLabel ??
          (ctaReq.secondaryKind === 'VIEW_MENU' ? 'Ver menú' : 'Ver destacados'),
      };

      resolvedPlan = await resolveCta({
        plannerRaw,
        businessId,
        lastReferencedProductId,
        detectedProductName: detectedProductName ?? ctaReq.productHint,
        botResponseText: formattedText,
        detectionQuantity: ctx.detection?.quantity ?? ctaReq.quantity,
        userMessage,
      });
    }

    const handlerResult = buildHybridCtaInteractive(formattedText, resolvedPlan);
    if (handlerResult) {
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
          ctaReq.productHint ?? detectedProductName
        );
      } catch (err) {
        console.error('[hybrid-cta] patchConversationMetadata failed:', err);
      }

      console.log(
        JSON.stringify({
          event: '[hybrid-cta] cta_shown',
          source: 'agent_tool',
          primaryKind: resolvedPlan.primary.kind,
          productId: primaryProductId,
          hadSecondary: !!resolvedPlan.secondary,
          conversationId,
        })
      );

      return { kind: 'response', handlerResult: markHybridResult(handlerResult) };
    }

    console.log(
      JSON.stringify({
        event: '[hybrid-cta] cta_skipped',
        reason: 'agent_tool_build_failed',
        conversationId,
      })
    );
  } else if (signals.presentProductCta) {
    console.log(
      JSON.stringify({
        event: '[hybrid-cta] cta_skipped',
        reason: 'feature_off',
        conversationId,
      })
    );
  }

  return {
    kind: 'response',
    handlerResult: markHybridResult({
      content: formattedText,
      isInteractive: false,
    }),
  };
};
