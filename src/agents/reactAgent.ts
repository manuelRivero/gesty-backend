/**
 * Agente ReAct híbrido — único camino de prosa (agent-first).
 *
 * Ownership de sesión (checkout, reserva, onboarding, dueño) y payloads de
 * botón no llegan acá. Sin clasificador de intent ni fork de producto.
 * Checkout en prosa: tool `start_checkout_session` → señal `delegate_checkout`.
 * Cambio de dirección en prosa: `start_address_edit_session` → onboarding (mismo
 * efecto que el botón EDIT_ADDRESS).
 *
 * CTA de producto: el agente llama `present_product_cta` si quiere botones/lista.
 * El runtime valida IDs y arma el interactive.
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { HumanMessage } from '@langchain/core/messages';
import { getReactReasonerLlm } from '../config/llm';
import { buildAgentHistoryMessages } from './conversationHistory';
import { buildContextMessage } from './contextMessage';
import { buildHybridAgentSystemPrompt } from '../prompts/botPersonality';
import { resolvePersonalityForBusiness } from '../services/botPersonality.service';
import { allReactTools } from '../tools';
import type { EnrichedContext, HandlerResult } from '../controllers/webhook/types';
import { formatBotUserMessage } from '../services/productQuery/utils';
import { normalizeWhatsAppBoldMarkers } from '../utils/whatsappBold';

import { prisma } from '../lib/prisma';
import {
  isHybridCtaEnabled,
  isHybridCtaEnabledForBusiness,
  isCheckoutAgentEnabled,
  isReservationAgentEnabled,
} from '../config/env';
import { resolveCta } from './ctaResolver';
import {
  buildHybridCtaInteractive,
  extractPrimaryPayload,
  extractPrimaryProductId,
  formatSelectListCandidateMeta,
} from '../whatsappBuilders/hybridCta';
import { patchConversationMetadata } from '../repositories';
import { startCheckoutSessionTool } from '../tools/checkout';
import { startReservationSessionTool } from '../tools/reservation';
import { startAddressEditSessionTool } from '../tools/onboarding';
import type { CtaPlan, CtaPlannerRaw } from './types';
import { persistLastOffer } from '../services/lastOffer.service';
import { buildCartSummaryMessage } from '../services/cart.service';
import { buildCancelOrderMessage } from '../services/order.service';
import { tryPresentComplementSuggestions } from '../services/complementSuggestions.service';
import { buildCategoryProductListMessage } from '../services/category.service';
import { findOrCreateConversationState } from '../repositories';
import { AddressService } from '../services/address.service';
import { buildSmallTalkMenu } from '../services/smallTalk.service';
import { SUPPORT_MESSAGE } from '../services/humanHandover.service';

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
  /** IDs autoritativos del shortlist (SELECT_FROM_LIST). */
  productIds: string[] | null;
  productId: string | null;
  quantity: number;
  primaryLabel: string | null;
  secondaryKind: CtaPlannerRaw['secondaryKind'];
  secondaryLabel: string | null;
};

const buildAgent = (personalityId: string, personalityPrompt: string) => {
  const checkoutDelegation = isCheckoutAgentEnabled();
  const reservationDelegation = isReservationAgentEnabled();
  const cacheKey = `${personalityId}:${checkoutDelegation ? 'checkout' : 'main'}:${
    reservationDelegation ? 'reservation' : 'noreservation'
  }`;
  let agent = cachedAgents.get(cacheKey);
  if (!agent) {
    const tools = [
      ...allReactTools,
      startAddressEditSessionTool,
      ...(checkoutDelegation ? [startCheckoutSessionTool] : []),
      ...(reservationDelegation ? [startReservationSessionTool] : []),
    ];
    agent = createReactAgent({
      llm: getReactReasonerLlm(),
      tools,
      prompt: buildHybridAgentSystemPrompt(personalityPrompt, {
        checkoutDelegationEnabled: checkoutDelegation,
        reservationDelegationEnabled: reservationDelegation,
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
  /** Reserva en prosa (tool start_reservation_session): abre la sesión de reservas. */
  startReservationSession: boolean;
  startReservationReason: string | null;
  /** Cambio de dirección en prosa (tool start_address_edit_session). */
  startAddressEditSession: boolean;
  startAddressEditReason: string | null;
  /** Escalado a humano en prosa (tool request_human_support); el efecto ya se aplicó. */
  requestHumanSupport: boolean;
  humanSupportMessage: string | null;
  presentCart: boolean;
  /** Cancela draft y/o orden creada (tool cancel_order). */
  cancelOrder: boolean;
  cancelOrderTarget: 'draft' | 'order' | null;
  /** Upsell de complemento (bebida/postre/etc.); productId opcional del último add. */
  presentComplementSuggestions: boolean;
  complementProductId: string | null;
  /** Lista de platillos de una categoría (misma UX que botón CATEGORY). */
  presentCategoryId: string | null;
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
  | { kind: 'delegate_checkout'; reason: string | null }
  | { kind: 'delegate_reservation'; reason: string | null }
  | { kind: 'delegate_address_edit'; reason: string | null };

const PRIMARY_KINDS = new Set(['ADD_ITEM', 'SELECT_FROM_LIST', 'VIEW_MENU', 'VIEW_FEATURED']);

const parsePresentProductCtaSignal = (data: Record<string, unknown>): PresentProductCtaSignal | null => {
  const primaryKind = data.primaryKind;
  if (typeof primaryKind !== 'string' || !PRIMARY_KINDS.has(primaryKind)) return null;

  const productHints = Array.isArray(data.productHints)
    ? data.productHints.filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
    : null;

  const productIds = Array.isArray(data.productIds)
    ? data.productIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : null;

  return {
    primaryKind: primaryKind as PresentProductCtaSignal['primaryKind'],
    productHint: typeof data.productHint === 'string' ? data.productHint : null,
    productHints: productHints && productHints.length > 0 ? productHints : null,
    productIds: productIds && productIds.length >= 2 ? productIds.slice(0, 10) : null,
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
    startReservationSession: false,
    startReservationReason: null,
    startAddressEditSession: false,
    startAddressEditReason: null,
    requestHumanSupport: false,
    humanSupportMessage: null,
    presentCart: false,
    cancelOrder: false,
    cancelOrderTarget: null,
    presentComplementSuggestions: false,
    complementProductId: null,
    presentCategoryId: null,
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
        productId?: string;
        target?: string;
      };
      if (data.signal === 'start_checkout_session') {
        signals.startCheckoutSession = true;
        signals.startCheckoutReason = typeof data.reason === 'string' ? data.reason : null;
      }
      if (data.signal === 'start_reservation_session') {
        signals.startReservationSession = true;
        signals.startReservationReason = typeof data.reason === 'string' ? data.reason : null;
      }
      if (data.signal === 'start_address_edit_session') {
        signals.startAddressEditSession = true;
        signals.startAddressEditReason = typeof data.reason === 'string' ? data.reason : null;
      }
      if (data.signal === 'request_human_support') {
        signals.requestHumanSupport = true;
        signals.humanSupportMessage =
          typeof data.message === 'string' && data.message.trim().length > 0
            ? data.message
            : null;
      }
      if (data.signal === 'present_cart') {
        signals.presentCart = true;
      }
      if (data.signal === 'cancel_order') {
        signals.cancelOrder = true;
        if (data.target === 'draft' || data.target === 'order') {
          signals.cancelOrderTarget = data.target;
        }
      }
      if (data.signal === 'present_complement_suggestions') {
        signals.presentComplementSuggestions = true;
        if (typeof data.productId === 'string' && data.productId.length > 0) {
          signals.complementProductId = data.productId;
        }
      }
      if (
        data.signal === 'present_category' &&
        typeof data.categoryId === 'string' &&
        data.categoryId.length > 0
      ) {
        signals.presentCategoryId = data.categoryId;
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
  const normalized = normalizeWhatsAppBoldMarkers(text.trim());
  if (!normalized) return normalized;
  if (normalized.startsWith('🤖')) return normalized;
  // Pregunta de party size sin encabezado: título canónico (no "*Respuesta* 💬").
  if (/para\s+cu[aá]ntas\s+personas/i.test(normalized)) {
    return formatBotUserMessage('¿Para cuántas personas?', '👥', normalized);
  }
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

/** SELECT_FROM_LIST desde IDs verificados en BD (body = intro del agente). */
const buildSelectFromListPlanFromIds = async (params: {
  productIds: string[];
  businessId: string;
  bodyText: string;
  secondaryLabel?: string | null;
  productHint?: string | null;
}): Promise<CtaPlan | null> => {
  const { productIds, businessId, bodyText, secondaryLabel, productHint } = params;
  if (productIds.length < 2) return null;

  try {
    const rows = await prisma.menu_item.findMany({
      where: {
        id: { in: productIds },
        business_id: businessId,
        is_available: true,
      },
      select: {
        id: true,
        name: true,
        description: true,
        serves_people: true,
        menu_item_price: {
          orderBy: { valid_from: 'desc' },
          take: 1,
          select: { amount: true },
        },
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = productIds
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r);

    if (ordered.length < 2) return null;

    return {
      productHint: productHint ?? undefined,
      primary: {
        kind: 'SELECT_FROM_LIST',
        candidates: ordered.slice(0, 10).map((r) => {
          const amount = r.menu_item_price[0]?.amount;
          const meta = formatSelectListCandidateMeta({
            servesPeople: r.serves_people,
            priceAmount: amount != null ? Number(amount) : null,
          });
          return {
            productId: r.id,
            title: r.name,
            description: meta ?? r.description ?? undefined,
          };
        }),
        bodyText,
      },
      secondary: {
        kind: 'VIEW_MENU' as const,
        label: (secondaryLabel ?? 'Ver menú').slice(0, 20),
      },
    };
  } catch (err) {
    console.error('[hybrid-cta] buildSelectFromListPlanFromIds failed:', err);
    return null;
  }
};

const emitHybridCtaResult = async (params: {
  conversationId: string;
  userMessage: string;
  formattedText: string;
  resolvedPlan: CtaPlan;
  source: string;
  productHintForOffer?: string | null;
}): Promise<HandlerResult | null> => {
  const { conversationId, userMessage, formattedText, resolvedPlan, source, productHintForOffer } =
    params;
  const handlerResult = buildHybridCtaInteractive(formattedText, resolvedPlan);
  if (!handlerResult) return null;

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
    await persistLastOfferFromCtaPlan(conversationId, resolvedPlan, productHintForOffer ?? null);
  } catch (err) {
    console.error('[hybrid-cta] patchConversationMetadata failed:', err);
  }

  console.log(
    JSON.stringify({
      event: '[hybrid-cta] cta_shown',
      source,
      primaryKind: resolvedPlan.primary.kind,
      productId: primaryProductId,
      hadSecondary: !!resolvedPlan.secondary,
      conversationId,
    })
  );

  return handlerResult;
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Ejecuta el ReAct agent. Si el agente no produce texto utilizable, devuelve
 * `null` para que el caller (nodo `nlpSubgraph` en modo hybrid) caiga al
 * handler determinístico.
 *
 * CTA / lista de productos: solo si el agente llamó `present_product_cta`.
 */
export const runHybridReactAgent = async (
  ctx: EnrichedContext
): Promise<HybridAgentRunResult | null> => {
  const businessId =
    typeof ctx.business === 'object' && ctx.business
      ? (ctx.business as { id: string }).id
      : '';
  if (!businessId) return null;

  // Pendings tipables (variación / cantidad): ledger en [ESTADO DEL CLIENTE].
  // El ReAct confirma con tools — sin router regex pre-ReAct.
  // Ver .cursor/rules/hybrid-pending-autonomy.mdc

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

  const turnStartedAt = new Date().toISOString();
  const out = await agent.invoke(inputs, {
    recursionLimit: 8,
    configurable: {
      businessId,
      customerId,
      customerPhone,
      conversationId,
      conversationStartedAt,
      turnStartedAt,
    },
  });

  const agentMessages = (out as { messages?: unknown[] }).messages ?? [];
  const signals = extractHybridSignals(agentMessages);

  // Escalado a humano: la tool ya marcó `is_human_handled`. Cortamos acá para no
  // dejar que el modelo siga conversando sobre un turno que ya no es suyo.
  if (signals.requestHumanSupport) {
    console.log(
      JSON.stringify({
        event: '[hybrid-agent] request_human_support',
        conversationId,
      })
    );
    return {
      kind: 'response',
      handlerResult: markHybridResult({
        content: signals.humanSupportMessage ?? SUPPORT_MESSAGE,
        isInteractive: false,
      }),
    };
  }

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

  if (signals.startReservationSession) {
    console.log(
      JSON.stringify({
        event: '[hybrid-agent] delegate_to_reservation',
        reason: signals.startReservationReason,
        conversationId,
      })
    );
    return {
      kind: 'delegate_reservation',
      reason: signals.startReservationReason,
    };
  }

  if (signals.startAddressEditSession) {
    console.log(
      JSON.stringify({
        event: '[hybrid-agent] delegate_to_address_edit',
        reason: signals.startAddressEditReason,
        conversationId,
      })
    );
    return {
      kind: 'delegate_address_edit',
      reason: signals.startAddressEditReason,
    };
  }

  if (signals.presentComplementSuggestions) {
    try {
      const business = ctx.business as Parameters<typeof tryPresentComplementSuggestions>[0]['business'];
      const draft = await prisma.draft_order.findFirst({
        where: { business_id: businessId, customer_phone: customerPhone, status: 'active' },
        select: {
          id: true,
          draft_order_item: {
            orderBy: { id: 'desc' },
            take: 1,
            select: { product_id: true },
          },
        },
      });
      const lastProductId =
        signals.complementProductId ??
        draft?.draft_order_item[0]?.product_id ??
        null;
      if (draft && lastProductId) {
        const state = await findOrCreateConversationState(conversationId);
        const listMsg = await tryPresentComplementSuggestions({
          business,
          conversationId,
          metadata: state.metadata,
          draftOrderId: draft.id,
          lastAddedMenuItemId: lastProductId,
          maxItems: 5,
          customerId: (ctx.customer as { id: string }).id,
        });
        if (listMsg) {
          console.log(
            JSON.stringify({
              event: '[hybrid-agent] present_complement_suggestions_signal',
              conversationId,
            })
          );
          // Un solo mensaje: confirmación + total + pitch + atajos (sin prosa aparte).
          return {
            kind: 'response',
            handlerResult: markHybridResult({ content: listMsg, isInteractive: true }),
          };
        }
        // Sin ola (cooldown/presupuesto/sin ítems): carrito completo, no categorías en prosa.
        console.log(
          JSON.stringify({
            event: '[hybrid-agent] present_complement_suggestions_fallback_cart',
            conversationId,
          })
        );
        signals.presentCart = true;
      }
    } catch (err) {
      console.error('[hybrid-agent] present_complement_suggestions failed, falling through', err);
      signals.presentCart = true;
    }
  }

  if (signals.cancelOrder) {
    try {
      const conversation = ctx.conversation as { id: string };
      const result = await buildCancelOrderMessage(
        conversation as Parameters<typeof buildCancelOrderMessage>[0],
        businessId,
        customerPhone,
        {
          target: signals.cancelOrderTarget ?? undefined,
        }
      );
      if (result) {
        console.log(
          JSON.stringify({
            event: '[hybrid-agent] cancel_order_signal',
            conversationId,
            target: signals.cancelOrderTarget,
          })
        );
        if (typeof result === 'string') {
          return {
            kind: 'response',
            handlerResult: markHybridResult({
              content: result,
              isInteractive: false,
            }),
          };
        }
        return {
          kind: 'response',
          handlerResult: markHybridResult({
            content: result,
            isInteractive: true,
          }),
        };
      }
    } catch (err) {
      console.error('[hybrid-agent] cancel_order failed, falling through', err);
    }
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

  if (signals.presentCategoryId) {
    try {
      const business = ctx.business as Parameters<typeof buildCategoryProductListMessage>[0];
      const conversation = ctx.conversation as Parameters<typeof buildCategoryProductListMessage>[1];
      const result = await buildCategoryProductListMessage(
        business,
        conversation,
        signals.presentCategoryId,
        1
      );
      if (result.message) {
        console.log(
          JSON.stringify({
            event: '[hybrid-agent] present_category_signal',
            categoryId: signals.presentCategoryId,
            conversationId,
          })
        );
        return {
          kind: 'response',
          handlerResult: markHybridResult({ content: result.message, isInteractive: true }),
        };
      }
      if (result.errorMessage) {
        return {
          kind: 'response',
          handlerResult: markHybridResult({
            content: ensureWhatsAppBotFormat(result.errorMessage),
            isInteractive: false,
          }),
        };
      }
    } catch (err) {
      console.error('[hybrid-agent] present_category failed, falling through', err);
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

  const detectedProductName = ctx.detection?.detectedProductName ?? null;
  const ctaFeatureOn =
    isHybridCtaEnabled() && isHybridCtaEnabledForBusiness(businessId);

  // CTA / lista: preferido si el agente pidió present_product_cta.
  if (signals.presentProductCta && ctaFeatureOn) {
    const ctaReq = signals.presentProductCta;
    const lastReferencedProductId =
      (ctx.conversation as { lastReferencedProductId?: string | null }).lastReferencedProductId ??
      null;

    let resolvedPlan: CtaPlan | null = null;

    if (
      ctaReq.primaryKind === 'SELECT_FROM_LIST' &&
      ctaReq.productIds &&
      ctaReq.productIds.length >= 2
    ) {
      resolvedPlan = await buildSelectFromListPlanFromIds({
        productIds: ctaReq.productIds,
        businessId,
        bodyText: formattedText,
        secondaryLabel: ctaReq.secondaryLabel,
        productHint: ctaReq.productHint,
      });
    }

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

    if (resolvedPlan) {
      const handlerResult = await emitHybridCtaResult({
        conversationId,
        userMessage,
        formattedText,
        resolvedPlan,
        source: 'agent_tool',
        productHintForOffer: ctaReq.productHint ?? detectedProductName,
      });
      if (handlerResult) {
        return { kind: 'response', handlerResult: markHybridResult(handlerResult) };
      }
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
