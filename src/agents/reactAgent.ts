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
import { HumanIntentToolNode } from './humanIntentToolNode';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { getHybridReasonerLlm } from '../config/llm';
import { buildAgentHistoryMessages } from './conversationHistory';
import { buildContextMessage } from './contextMessage';
import {
  applyCheckoutTurnGate,
  CHECKOUT_EMPTY_CART_MESSAGE,
  toolMessageMutatedCart,
} from './checkoutTurnPolicy';
import { buildHybridAgentSystemPrompt } from '../prompts/botPersonality';
import { resolvePersonalityForBusiness } from '../services/botPersonality.service';
import { allReactTools } from '../tools';
import { getGoalFulfillmentContract } from '../domain/intent/family';
import type {
  EnrichedContext,
  HandlerFollowUp,
  HandlerResult,
} from '../controllers/webhook/types';
import type {
  WhatsAppInteractiveMessage,
  WhatsAppListMessage,
} from '../domain/intent/whatsappTemplates';
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
import { patchConversationMetadata, omitConversationMetadataKeys } from '../repositories';
import { startCheckoutSessionTool } from '../tools/checkout';
import { startReservationSessionTool } from '../tools/reservation';
import { startAddressEditSessionTool } from '../tools/onboarding';
import type { CtaPlan, CtaPlannerRaw } from './types';
import { persistLastOffer } from '../services/lastOffer.service';
import { issueProductResolutions } from '../services/productResolution.service';
import { buildCartSummaryMessage } from '../services/cart.service';
import { buildCancelOrderMessage, buildCancelDisambiguationMessage } from '../services/order.service';
import {
  presentItemNoteSuccessList,
  productIdPersistedForComplement,
  tryPresentComplementSuggestions,
} from '../services/complementSuggestions.service';
import { buildCategoryProductListMessage } from '../services/category.service';
import { findOrCreateConversationState } from '../repositories';
import { AddressService } from '../services/address.service';
import { buildSmallTalkMenu } from '../services/smallTalk.service';
import { SUPPORT_MESSAGE } from '../services/humanHandover.service';
import {
  clearWelcomeEligible,
  isWelcomeEligible,
  isWelcomeEligibleGreeting,
} from '../services/welcomeEligible.service';
import { normalizeMetadata } from '../services/productQuery/utils';
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

/** Una presentación pedida en este turno. El orden del array es el de tool_calls. */
export type PresentationCommand =
  | {
      type: 'category';
      categoryId: string;
      bodyText: string | null;
    }
  | {
      type: 'product_cta';
      cta: PresentProductCtaSignal;
    };

const buildAgent = (
  personalityId: string,
  personalityPrompt: string,
  timezone?: string | null,
  requiredToolChoice?: string
) => {
  const checkoutDelegation = isCheckoutAgentEnabled();
  const reservationDelegation = isReservationAgentEnabled();
  const cultureKey = timezone?.trim() || 'default';
  const cacheKey = `${personalityId}:${checkoutDelegation ? 'checkout' : 'main'}:${
    reservationDelegation ? 'reservation' : 'noreservation'
  }:${cultureKey}:${requiredToolChoice ?? 'auto'}`;
  let agent = cachedAgents.get(cacheKey);
  if (!agent) {
    const tools = [
      ...allReactTools,
      startAddressEditSessionTool,
      ...(checkoutDelegation ? [startCheckoutSessionTool] : []),
      ...(reservationDelegation ? [startReservationSessionTool] : []),
    ];
    const llm = getHybridReasonerLlm();
    if (typeof llm.bindTools !== 'function' && requiredToolChoice) {
      throw new Error('The configured ReAct model does not support required tool_choice');
    }
    const llmForAgent =
      typeof llm.bindTools === 'function'
        ? requiredToolChoice
          ? (state: { messages: BaseMessage[] }) => {
              const lastMessage = state.messages[state.messages.length - 1];
              const initialHumanTurn = lastMessage?._getType() === 'human';
              const toolChoice = initialHumanTurn ? requiredToolChoice : undefined;
              return llm.bindTools(tools, {
                parallel_tool_calls: !toolChoice,
                ...(toolChoice ? { tool_choice: toolChoice } : {}),
              });
            }
          : llm.bindTools(tools, { parallel_tool_calls: true })
        : llm;
    agent = createReactAgent({
      llm: llmForAgent,
      tools: new HumanIntentToolNode(tools),
      prompt: buildHybridAgentSystemPrompt(personalityPrompt, {
        checkoutDelegationEnabled: checkoutDelegation,
        reservationDelegationEnabled: reservationDelegation,
        timezone,
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
  businessId: string,
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
    businessId,
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
  /**
   * Carrito activo al pedir reserva: el sistema muestra confirmación tipable/botones
   * (no abre la reserva todavía).
   */
  askCancelCartForReservation: boolean;
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
  presentCategoryBody: string | null;
  presentAddressConfirmation: boolean;
  /** Texto normalizado de la última dirección dejada `in_coverage` por `stage_delivery_address` este turno. */
  stagedAddressText: string | null;
  presentWelcomeOptions: boolean;
  welcomeBodyText: string | null;
  /** CTA de producto pedido explícitamente por el agente (tool present_product_cta). */
  presentProductCta: PresentProductCtaSignal | null;
  /**
   * Presentaciones de este turno (`present_category`, `present_product_cta`)
   * en el orden de `tool_calls` del AIMessage. Varias no se pisan.
   */
  presentationCommands: PresentationCommand[];
  /** True si add_cart_item devolvió success en este turno (no reabrir shortlist). */
  cartAddSucceeded: boolean;
  /** Un add fallido no puede quedar cubierto por prosa afirmativa del LLM. */
  cartAddFailed: boolean;
  /** Resultado ausente/no booleano: dejar que dispatch verifique el draft persistido. */
  cartAddUnknown: boolean;
  /** Effects exitosos observados en ToolMessages de este turno. */
  successfulEffectCount: number;
  /** Siguiente línea cuya cantidad UNKNOWN debe preguntarse tras un efecto. */
  nextQuantityTarget: { id: string; hint: string } | null;
  /** Producto del último add_cart_item exitoso de este turno. */
  lastAddedProductId: string | null;
  /**
   * add, update de cantidad o remove con success en este turno.
   * Checkout pedido en el mismo turno no se delega: el carrito se presenta primero.
   */
  cartMutatedThisTurn: boolean;
  /**
   * add_cart_item falló con pending tipable (cantidad/variación): no honrar
   * present_complement / present_cart de cierre; preferí askMessage.
   */
  cartAddPendingGate: boolean;
  /** askMessage de quantity_required / variation_required si el add no escribió. */
  cartAddPendingAskMessage: string | null;
  /**
   * add falló con complement_selection_required (mensaje no elige candidato de la ola).
   * No tapar con cart/complement; si mark_complement_refused + present_cart, sí honrar cart.
   */
  cartAddComplementBlocked: boolean;
  /** mark_complement_refused devolvió refused este turno. */
  markComplementRefused: boolean;
  /**
   * update_item_note escribió la nota. El runtime cierra con la lista de
   * gestión (y la ola de complementos si sigue viva), no con prosa del modelo.
   */
  itemNoteSaved: boolean;
  itemNoteItemNames: string[];
  itemNoteText: string | null;
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

/** Args resumidos: solo lo que sirve para reconstruir por qué eligió un producto. */
const TRACED_ARG_KEYS = [
  'query',
  'keyword',
  'hint',
  'lines',
  'productId',
  'productIds',
  'itemIndex',
  'quantity',
  'count',
  'variation',
  'categoryTag',
  'categoryId',
  'containsIngredient',
  'excludesIngredient',
  'primaryKind',
  'productHint',
] as const;

const summarizeToolArgs = (args: unknown): Record<string, unknown> => {
  if (typeof args !== 'object' || args === null) return {};
  const src = args as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of TRACED_ARG_KEYS) {
    const value = src[key];
    if (value == null) continue;
    if (key === 'lines' && Array.isArray(value)) {
      out.lines = value.map((l) => {
        const line = (typeof l === 'object' && l !== null ? l : {}) as Record<string, unknown>;
        return `${String(line.hint ?? '?')}×${line.requestedQuantity ?? '—'}`;
      });
      continue;
    }
    out[key] = typeof value === 'string' ? value.slice(0, 80) : value;
  }
  return out;
};

/**
 * Traza de tools del turno. Sin esto no se puede auditar con qué tool resolvió
 * el modelo un producto: los logs solo mostraban las búsquedas semánticas (que
 * loguean por su cuenta), así que un add resuelto por `find_products_by_filter`
 * era invisible.
 */
const logToolCallTrace = (
  messages: unknown[],
  conversationId: string | undefined,
  turnId: string | undefined
): void => {
  const calls: Array<{ id: string | null; tool: string; args: Record<string, unknown> }> = [];
  const results: Array<{
    tool: string;
    id: string | null;
    success: boolean | null;
    effect: Record<string, unknown> | null;
    error: string | null;
    status: string | null;
    resultCount: number | null;
  }> = [];
  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue;
    const m = msg as Record<string, unknown>;

    if (typeof m.name === 'string') {
      const rawContent = typeof m.content === 'string' ? m.content : null;
      if (rawContent) {
        try {
          const data = JSON.parse(rawContent) as Record<string, unknown>;
          const effect =
            typeof data.effect === 'object' && data.effect !== null
              ? (data.effect as Record<string, unknown>)
              : null;
          results.push({
            tool: m.name,
            id: typeof m.tool_call_id === 'string' ? m.tool_call_id : null,
            success: typeof data.success === 'boolean' ? data.success : null,
            effect,
            error: typeof data.error === 'string' ? data.error : null,
            status: typeof m.status === 'string' ? m.status : null,
            resultCount: typeof data.count === 'number' ? data.count : null,
          });
        } catch {
          results.push({
            tool: m.name,
            id: typeof m.tool_call_id === 'string' ? m.tool_call_id : null,
            success: null,
            effect: null,
            error: null,
            status: typeof m.status === 'string' ? m.status : null,
            resultCount: null,
          });
        }
      }
    }

    const raw = (msg as Record<string, unknown>).tool_calls;
    if (!Array.isArray(raw)) continue;
    for (const call of raw) {
      if (typeof call !== 'object' || call === null) continue;
      const c = call as Record<string, unknown>;
      if (typeof c.name !== 'string') continue;
      calls.push({
        id: typeof c.id === 'string' ? c.id : null,
        tool: c.name,
        args: summarizeToolArgs(c.args),
      });
    }
  }
  console.log(JSON.stringify({ event: '[react]', turnId, tools: calls.length }));
  if (calls.length === 0) return;
  for (const result of results) {
    console.log(JSON.stringify({
      event: '[tool]',
      turnId,
      name: result.tool,
      success: result.success,
      effect: typeof result.effect?.kind === 'string' ? result.effect.kind : null,
      status: result.status,
      ...(result.resultCount != null ? { results: result.resultCount } : {}),
    }));
  }
  console.debug(JSON.stringify({
    event: '[hybrid-agent] tool_trace',
    turnId,
    conversationId,
    toolCount: calls.length,
    calls,
    results,
  }));
};

const extractHybridSignals = (messages: unknown[]): HybridAgentSignals => {
  const signals: HybridAgentSignals = {
    startCheckoutSession: false,
    startCheckoutReason: null,
    startReservationSession: false,
    startReservationReason: null,
    askCancelCartForReservation: false,
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
    presentCategoryBody: null,
    presentAddressConfirmation: false,
    stagedAddressText: null,
    presentWelcomeOptions: false,
    welcomeBodyText: null,
    presentProductCta: null,
    presentationCommands: [],
    cartAddSucceeded: false,
      cartAddFailed: false,
    cartAddUnknown: false,
    successfulEffectCount: 0,
    nextQuantityTarget: null,
    lastAddedProductId: null,
    cartMutatedThisTurn: false,
    cartAddPendingGate: false,
    cartAddPendingAskMessage: null,
    cartAddComplementBlocked: false,
    markComplementRefused: false,
    itemNoteSaved: false,
    itemNoteItemNames: [],
    itemNoteText: null,
  };

  const stagedPresentations: Array<{ toolCallId: string; command: PresentationCommand }> = [];
  const addCartCallCount = messages.reduce<number>((count, msg) => {
    if (typeof msg !== 'object' || msg === null) return count;
    const toolCalls = (msg as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(toolCalls)) return count;
    return count + toolCalls.filter((call) =>
      typeof call === 'object' && call !== null &&
      (call as { name?: unknown }).name === 'add_cart_item'
    ).length;
  }, 0);
  let addCartResultCount = 0;
  let addCartUnknownResult = false;

  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue;
    const m = msg as Record<string, unknown>;

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
        success?: boolean;
        error?: string;
        askMessage?: string;
      };
            if (m.name === 'add_cart_item') {
        if (typeof data.success === 'boolean') addCartResultCount += 1;
        else addCartUnknownResult = true;
      }
            if (m.name === 'add_cart_item' && data.success === true) {
        signals.cartAddSucceeded = true;
        const added = data.added;
        if (
          added &&
          typeof added === 'object' &&
          typeof (added as { productId?: unknown }).productId === 'string'
        ) {
          signals.lastAddedProductId = (added as { productId: string }).productId;
        }
      }
      if (m.name === 'add_cart_item' && data.success === false) {
        signals.cartAddFailed = true;
      }
      if (
        data.success === true &&
        typeof data.effect === 'object' &&
        data.effect !== null
      ) {
        signals.successfulEffectCount += 1;
        const nextGoal = data.nextGoal;
        const goalTarget =
          nextGoal && typeof nextGoal === 'object'
            ? (nextGoal as { target?: unknown }).target
            : null;
        const directTarget = data.nextQuantityTarget;
        const target = goalTarget ?? directTarget;
        if (
          target &&
          typeof target === 'object' &&
          typeof (target as { hint?: unknown }).hint === 'string'
        ) {
          const id =
            typeof (target as { orderLineId?: unknown }).orderLineId === 'string'
              ? (target as { orderLineId: string }).orderLineId
              : typeof (target as { id?: unknown }).id === 'string'
                ? (target as { id: string }).id
                : null;
          if (id) {
            signals.nextQuantityTarget = {
              id,
              hint: (target as { hint: string }).hint,
            };
          }
        }
      }
      if (toolMessageMutatedCart(m.name, data.success)) {
        signals.cartMutatedThisTurn = true;
      }
      if (m.name === 'update_item_note' && data.success === true) {
        signals.itemNoteSaved = true;
        const names: string[] = [];
        if (Array.isArray(data.items)) {
          for (const row of data.items) {
            if (
              row &&
              typeof row === 'object' &&
              typeof (row as { itemName?: unknown }).itemName === 'string'
            ) {
              names.push((row as { itemName: string }).itemName);
            }
          }
        }
        if (names.length === 0 && typeof data.itemName === 'string' && data.itemName.trim()) {
          names.push(data.itemName);
        }
        signals.itemNoteItemNames = names;
        signals.itemNoteText = typeof data.note === 'string' ? data.note : null;
      }
      // Post-remove: el cierre es el resumen interactivo (mismo que VIEW_CART),
      // no prosa inventada con total suelto. Honramos present_cart aunque el
      // modelo no haya llamado la tool de señal.
      if (m.name === 'remove_cart_item' && data.success === true) {
        signals.presentCart = true;
      }
      if (m.name === 'update_cart_item_quantity' && data.success === true) {
        signals.presentCart = true;
      }
      if (
        m.name === 'add_cart_item' &&
        data.success === false &&
        (data.error === 'quantity_required' ||
          data.error === 'variation_required' ||
          data.error === 'variation_invalid')
      ) {
        signals.cartAddPendingGate = true;
        if (typeof data.askMessage === 'string' && data.askMessage.trim()) {
          signals.cartAddPendingAskMessage = data.askMessage;
        }
      }
      if (
        m.name === 'add_cart_item' &&
        data.success === false &&
        data.error === 'complement_selection_required'
      ) {
        signals.cartAddComplementBlocked = true;
      }
      if (m.name === 'mark_complement_refused' && data.refused === true) {
        signals.markComplementRefused = true;
      }
      if (data.signal === 'start_checkout_session') {
        signals.startCheckoutSession = true;
        signals.startCheckoutReason = typeof data.reason === 'string' ? data.reason : null;
      }
      if (data.signal === 'start_reservation_session') {
        signals.startReservationSession = true;
        signals.startReservationReason = typeof data.reason === 'string' ? data.reason : null;
      }
      if (data.signal === 'ask_cancel_cart_for_reservation') {
        signals.askCancelCartForReservation = true;
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
        typeof m.tool_call_id === 'string' &&
        typeof data.categoryId === 'string' &&
        data.categoryId.length > 0
      ) {
        stagedPresentations.push({
          toolCallId: m.tool_call_id,
          command: {
            type: 'category',
            categoryId: data.categoryId,
            bodyText:
              typeof data.bodyText === 'string' && data.bodyText.trim()
                ? data.bodyText.trim()
                : null,
          },
        });
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
        if (parsed && typeof m.tool_call_id === 'string') {
          stagedPresentations.push({
            toolCallId: m.tool_call_id,
            command: { type: 'product_cta', cta: parsed },
          });
        }
      }
    } catch {
      if (m.name === 'add_cart_item') addCartUnknownResult = true;
      /* ignorar mensajes no-JSON */
    }
  }

  signals.cartAddUnknown =
    addCartUnknownResult || addCartResultCount < addCartCallCount;
  signals.presentationCommands = alignPresentationCommands(messages, stagedPresentations);
  for (const command of signals.presentationCommands) {
    if (command.type === 'category') {
      signals.presentCategoryId = command.categoryId;
      signals.presentCategoryBody = command.bodyText;
    } else {
      signals.presentProductCta = command.cta;
    }
  }

  return signals;
};

/**
 * Orden de presentaciones = orden de `tool_calls` en cada AIMessage.
 * Los ToolMessage pueden llegar en otro orden (Promise.all); el id los reubica.
 * Sin `tool_calls` (tests y lotes ya ordenados), se conserva el orden de los ToolMessage.
 */
const alignPresentationCommands = (
  messages: unknown[],
  staged: Array<{ toolCallId: string; command: PresentationCommand }>
): PresentationCommand[] => {
  const byId = new Map(staged.map((item) => [item.toolCallId, item.command]));
  const ordered: PresentationCommand[] = [];
  const used = new Set<string>();

  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue;
    const calls = (msg as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (typeof call !== 'object' || call === null) continue;
      const id = (call as { id?: unknown }).id;
      if (typeof id !== 'string' || used.has(id)) continue;
      const command = byId.get(id);
      if (!command) continue;
      ordered.push(command);
      used.add(id);
    }
  }

  for (const item of staged) {
    if (used.has(item.toolCallId)) continue;
    ordered.push(item.command);
    used.add(item.toolCallId);
  }

  return ordered;
};

/**
 * Rol del mensaje del grafo. Los objetos planos `{ content }` de tests
 * no tienen tipo: se tratan como prosa del asistente.
 */
const messageRole = (msg: unknown): 'tool' | 'human' | 'system' | 'assistant' => {
  if (typeof msg !== 'object' || msg === null) return 'assistant';
  const record = msg as {
    tool_call_id?: unknown;
    getType?: () => string;
    _getType?: () => string;
    type?: unknown;
  };
  if (typeof record.tool_call_id === 'string') return 'tool';
  const typed =
    typeof record.getType === 'function'
      ? record.getType()
      : typeof record._getType === 'function'
        ? record._getType()
        : typeof record.type === 'string'
          ? record.type
          : null;
  if (typed === 'tool') return 'tool';
  if (typed === 'human') return 'human';
  if (typed === 'system') return 'system';
  return 'assistant';
};

const readMessageContent = (msg: unknown): string | null => {
  if (typeof msg !== 'object' || msg === null) return null;
  const content = (msg as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (
      content
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

/**
 * Prosa del asistente en este turno. Los ToolMessage (incluida una señal
 * `returnDirect`, que deja el resultado de la tool como último mensaje) son
 * control del orquestador: `extractHybridSignals` ya los consume. No son
 * texto para WhatsApp ni `llmProse` a anteponer en un body interactivo.
 */
const extractFinalText = (result: unknown): string | null => {
  if (typeof result !== 'object' || result === null) return null;
  const messages = (result as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  let index = messages.length - 1;
  while (index >= 0 && messageRole(messages[index]) === 'tool') {
    index -= 1;
  }
  if (index < 0) return null;

  const candidate = messages[index];
  const role = messageRole(candidate);
  if (role === 'human' || role === 'system') return null;
  return readMessageContent(candidate);
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
          where: {
            is_active: true,
            valid_from: { lte: new Date() },
            OR: [{ valid_to: null }, { valid_to: { gte: new Date() } }],
          },
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
  businessId: string;
  userMessage: string;
  formattedText: string;
  resolvedPlan: CtaPlan;
  source: string;
  productHintForOffer?: string | null;
}): Promise<HandlerResult | null> => {
  const { conversationId, businessId, userMessage, formattedText, resolvedPlan, source, productHintForOffer } =
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
      if (selectListCandidateIds) {
        await issueProductResolutions({
          productIds: selectListCandidateIds,
          businessId,
          conversationId,
          source: 'whatsapp_presentation',
          status: 'candidate',
          scope: 'conversation',
        });
      }
    await persistLastOfferFromCtaPlan(
      conversationId,
      businessId,
      resolvedPlan,
      productHintForOffer ?? null
    );
  } catch (err) {
    console.error('[hybrid-cta] patchConversationMetadata failed:', err);
  }

  console.debug(
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

const handlerResultToFollowUp = (result: HandlerResult): HandlerFollowUp | null => {
  if (!result.isInteractive && typeof result.content === 'string') {
    return { type: 'text', message: result.content };
  }
  if (result.isInteractive && result.content && typeof result.content === 'object') {
    const typed = result.content as { type?: string };
    if (typed.type === 'list') {
      return { type: 'list', listMessage: result.content as WhatsAppListMessage };
    }
    if (typed.type === 'interactive') {
      return { type: 'interactive', message: result.content as WhatsAppInteractiveMessage };
    }
  }
  return null;
};

/** Primera presentación = content. El resto, en el mismo orden, = followUps. */
const packPresentationResults = (parts: HandlerResult[]): HandlerResult | null => {
  if (parts.length === 0) return null;
  const [first, ...rest] = parts;
  const followUps: HandlerFollowUp[] = [];
  for (const part of rest) {
    const follow = handlerResultToFollowUp(part);
    if (!follow) {
      console.error(
        JSON.stringify({
          event: '[hybrid-agent] presentation_follow_up_unmapped',
        })
      );
      continue;
    }
    followUps.push(follow);
  }
  return markHybridResult({
    content: first.content,
    isInteractive: first.isInteractive,
    ...(followUps.length > 0 ? { followUps } : {}),
  });
};

type PresentationBuildCtx = {
  ctx: EnrichedContext;
  businessId: string;
  conversationId: string;
  formattedText: string;
  userMessage: string;
  detectedProductName: string | null;
  detectionQuantity: number | null;
  lastReferencedProductId: string | null;
};

const materializeCategoryPresentation = async (
  command: Extract<PresentationCommand, { type: 'category' }>,
  buildCtx: PresentationBuildCtx
): Promise<HandlerResult | null> => {
  try {
    const business = buildCtx.ctx.business as Parameters<typeof buildCategoryProductListMessage>[0];
    const conversation = buildCtx.ctx.conversation as Parameters<
      typeof buildCategoryProductListMessage
    >[1];
    const result = await buildCategoryProductListMessage(
      business,
      conversation,
      command.categoryId,
      1,
      { bodyText: command.bodyText }
    );
    if (result.message) {
      console.debug(
        JSON.stringify({
          event: '[hybrid-agent] present_category_signal',
          categoryId: command.categoryId,
          conversationId: buildCtx.conversationId,
        })
      );
      return { content: result.message, isInteractive: true };
    }
    if (result.errorMessage) {
      return {
        content: ensureWhatsAppBotFormat(result.errorMessage),
        isInteractive: false,
      };
    }
  } catch (err) {
    console.error('[hybrid-agent] present_category failed, falling through', err);
  }
  return null;
};

const materializeProductCtaPresentation = async (
  ctaReq: PresentProductCtaSignal,
  buildCtx: PresentationBuildCtx
): Promise<HandlerResult | null> => {
  const {
    businessId,
    conversationId,
    formattedText,
    userMessage,
    detectedProductName,
    detectionQuantity,
    lastReferencedProductId,
  } = buildCtx;

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
      detectionQuantity: detectionQuantity ?? ctaReq.quantity,
      userMessage,
    });
  }

  if (resolvedPlan) {
    const handlerResult = await emitHybridCtaResult({
      conversationId,
      businessId,
      userMessage,
      formattedText,
      resolvedPlan,
      source: 'agent_tool',
      productHintForOffer: ctaReq.productHint ?? detectedProductName,
    });
    if (handlerResult) return handlerResult;
  }

  console.debug(
    JSON.stringify({
      event: '[hybrid-cta] cta_skipped',
      reason: 'agent_tool_build_failed',
      conversationId,
    })
  );
  return null;
};

const composeOrderedPresentations = async (
  commands: PresentationCommand[],
  buildCtx: PresentationBuildCtx,
  options: { ctaFeatureOn: boolean; cartAddSucceeded: boolean }
): Promise<HandlerResult | null> => {
  const parts: HandlerResult[] = [];
  for (const command of commands) {
    if (command.type === 'product_cta') {
      if (options.cartAddSucceeded) {
        console.debug(
          JSON.stringify({
            event: '[hybrid-cta] cta_skipped',
            reason: 'cart_add_same_turn',
            conversationId: buildCtx.conversationId,
          })
        );
        continue;
      }
      if (!options.ctaFeatureOn) {
        console.debug(
          JSON.stringify({
            event: '[hybrid-cta] cta_skipped',
            reason: 'feature_off',
            conversationId: buildCtx.conversationId,
          })
        );
        continue;
      }
      const built = await materializeProductCtaPresentation(command.cta, buildCtx);
      if (built) parts.push(built);
      continue;
    }
    const built = await materializeCategoryPresentation(command, buildCtx);
    if (built) parts.push(built);
  }
  return packPresentationResults(parts);
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
  const businessTimezone =
    typeof ctx.business === 'object' && ctx.business
      ? (ctx.business as { timezone?: string | null }).timezone
      : null;
  const activeBlockingGoal = ctx.activeBlockingGoal;
  const fulfillmentCandidate = ctx.goalFulfillmentCandidate;
  const fulfillmentContract =
    fulfillmentCandidate && fulfillmentCandidate.goalType === activeBlockingGoal
      ? getGoalFulfillmentContract(fulfillmentCandidate.goalType)
      : undefined;
  const requiredToolChoice = fulfillmentContract?.fulfillmentTool;
  const availableTools = [
    ...allReactTools,
    startAddressEditSessionTool,
    ...(isCheckoutAgentEnabled() ? [startCheckoutSessionTool] : []),
    ...(isReservationAgentEnabled() ? [startReservationSessionTool] : []),
  ];
  const fulfillmentToolAvailable = Boolean(
    requiredToolChoice && availableTools.some((tool) => tool.name === requiredToolChoice)
  );
  const enforcedToolChoice = fulfillmentToolAvailable ? requiredToolChoice : undefined;
  if (activeBlockingGoal) {
    console.log(JSON.stringify({
      event: '[goal-fulfillment]',
      goal: activeBlockingGoal,
      ...(enforcedToolChoice ? { tool: enforcedToolChoice } : {}),
      toolChoice: enforcedToolChoice ? 'required' : 'none',
    }));
  }
  const agent = buildAgent(
    personalityId,
    promptText,
    businessTimezone,
    enforcedToolChoice
  );

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

  // Nuevo turno del usuario: ya puede elegir del shortlist / add. El flag solo
  // bloquea add en el mismo ReAct en que se abrió la búsqueda (≥2).
  try {
    await omitConversationMetadataKeys(conversationId, ['shortlistAwaitingChoice']);
  } catch (err) {
    console.error('[hybrid-agent] clear shortlistAwaitingChoice failed:', err);
  }

  const inputs = {
    messages: [...history, new HumanMessage(await buildContextMessage(ctx))],
  };

  const turnStartedAt = new Date().toISOString();
  const userMessageForTools = ctx.message?.text?.body ?? '';
  const out = await agent.invoke(inputs, {
    recursionLimit: 12,
    configurable: {
      businessId,
      customerId,
      customerPhone,
      conversationId,
      conversationStartedAt,
      turnStartedAt,
      turnId: ctx.turnId,
      userMessage: userMessageForTools,
      ...(typeof ctx.humanIntentGateRevision === 'number'
        ? { humanIntentGateRevision: ctx.humanIntentGateRevision }
        : {}),
    },
  });

  const agentMessages = (out as { messages?: unknown[] }).messages ?? [];
  const llmProse = extractFinalText(out);
  logToolCallTrace(agentMessages, conversationId, ctx.turnId);
  if (enforcedToolChoice && fulfillmentCandidate) {
    const emitted = agentMessages.some((message) => {
      if (typeof message !== 'object' || message === null) return false;
      const calls = (message as { tool_calls?: unknown }).tool_calls;
      return Array.isArray(calls) && calls.some(
        (call) =>
          typeof call === 'object' &&
          call !== null &&
          (call as { name?: unknown }).name === enforcedToolChoice
      );
    });
    console.log(JSON.stringify({
      event: '[goal-fulfillment]',
      goal: fulfillmentCandidate.goalType,
      tool: enforcedToolChoice,
      toolChoice: 'required',
      result: emitted ? 'tool_emitted' : 'tool_not_emitted',
    }));
  }
  const signals = extractHybridSignals(agentMessages);
  const metaAtTurnStart = normalizeMetadata(ctx.conversationState?.metadata);
  const pendingCancelAtTurnStart = metaAtTurnStart.pending_cancel_disambiguation;

  // Post-cancel (welcomeEligible): saludo sin intención → forzar welcome tipable
  // aunque el LLM omita la tool o invente party size.
  try {
    const liveState = await findOrCreateConversationState(conversationId);
    if (isWelcomeEligible(liveState.metadata)) {
      const userMsg = ctx.message?.text?.body ?? '';
      const busyDomain =
        signals.cartAddSucceeded ||
        signals.startReservationSession ||
        signals.startCheckoutSession ||
        signals.presentCart ||
        signals.presentProductCta != null ||
        signals.presentComplementSuggestions ||
        signals.itemNoteSaved;
      if (
        isWelcomeEligibleGreeting(userMsg) &&
        !signals.presentWelcomeOptions &&
        !busyDomain
      ) {
        signals.presentWelcomeOptions = true;
        signals.welcomeBodyText =
          '¡Hola! ¿Te ayudo con el menú, un pedido o una reserva de mesa?';
        console.debug(
          JSON.stringify({
            event: '[hybrid-agent] welcome_eligible_force_welcome',
            conversationId,
          })
        );
      }
    }
  } catch (err) {
    console.error('[hybrid-agent] welcomeEligible check failed:', err);
  }

  // Desambiguación cancel tipable: si el modelo no llamó cancel_order, no dejar
  // pasar prosa inventada ni present_cart competidor — re-mostrar botones.
  if (
    pendingCancelAtTurnStart &&
    typeof pendingCancelAtTurnStart === 'object' &&
    typeof pendingCancelAtTurnStart.orderRef === 'string' &&
    !signals.cancelOrder
  ) {
    const allowedEscape =
      signals.startReservationSession ||
      signals.startCheckoutSession ||
      signals.startAddressEditSession ||
      signals.requestHumanSupport;
    if (!allowedEscape) {
      console.debug(
        JSON.stringify({
          event: '[hybrid-agent] cancel_disambiguation_guard',
          conversationId,
          orderRef: pendingCancelAtTurnStart.orderRef,
        })
      );
      return {
        kind: 'response',
        handlerResult: markHybridResult({
          content: buildCancelDisambiguationMessage(pendingCancelAtTurnStart.orderRef),
          isInteractive: true,
          skipBodyHumanization: true,
        }),
      };
    }
  }

  if (signals.cartAddSucceeded) {
    await clearWelcomeEligible(conversationId).catch(() => undefined);
  }

  // Escalado a humano: la tool ya marcó `is_human_handled`. Cortamos acá para no
  // dejar que el modelo siga conversando sobre un turno que ya no es suyo.
  if (signals.requestHumanSupport) {
    console.debug(
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
    const decision = await applyCheckoutTurnGate({
      startCheckoutSession: true,
      startCheckoutReason: signals.startCheckoutReason,
      cartMutatedThisTurn: signals.cartMutatedThisTurn,
      readDraftHasItems: async () => {
        const draft = await prisma.draft_order.findFirst({
          where: {
            business_id: businessId,
            customer_phone: customerPhone,
            status: 'active',
          },
          select: { draft_order_item: { select: { id: true }, take: 1 } },
        });
        return Boolean(draft && draft.draft_order_item.length > 0);
      },
    });
    if (decision.type === 'delegate') {
      console.debug(
        JSON.stringify({
          event: '[hybrid-agent] delegate_to_checkout',
          reason: signals.startCheckoutReason,
          conversationId,
        })
      );
      await clearWelcomeEligible(conversationId).catch(() => undefined);
      return {
        kind: 'delegate_checkout',
        reason: decision.reason,
      };
    }
    if (decision.type === 'empty_cart') {
      console.debug(
        JSON.stringify({
          event: '[hybrid-agent] start_checkout_empty_cart',
          conversationId,
        })
      );
      return {
        kind: 'response',
        handlerResult: markHybridResult({
          content: formatBotUserMessage(
            'Tu pedido está vacío',
            '🛒',
            CHECKOUT_EMPTY_CART_MESSAGE
          ),
          isInteractive: false,
        }),
      };
    }
    if (decision.type === 'defer_present_cart') {
      signals.presentCart = true;
      signals.startCheckoutSession = false;
      console.debug(
        JSON.stringify({
          event: '[hybrid-agent] checkout_deferred_cart_mutation',
          conversationId,
          draftHasItems: decision.draftHasItems,
        })
      );
    }
  }

  if (signals.askCancelCartForReservation) {
    const { buildSwitchToReservationConfirmMessage } = await import(
      '../services/switchToReservationConfirm.service'
    );
    console.debug(
      JSON.stringify({
        event: '[hybrid-agent] ask_cancel_cart_for_reservation',
        conversationId,
      })
    );
    return {
      kind: 'response',
      handlerResult: {
        content: buildSwitchToReservationConfirmMessage(),
        isInteractive: true,
        skipBodyHumanization: true,
      },
    };
  }

  if (signals.startReservationSession) {
    console.debug(
      JSON.stringify({
        event: '[hybrid-agent] delegate_to_reservation',
        reason: signals.startReservationReason,
        conversationId,
      })
    );
    await clearWelcomeEligible(conversationId).catch(() => undefined);
    return {
      kind: 'delegate_reservation',
      reason: signals.startReservationReason,
    };
  }

  if (signals.startAddressEditSession) {
    console.debug(
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
    if (!signals.cartAddSucceeded) {
      console.debug(
        JSON.stringify({
          event: '[hybrid-agent] present_complement_skipped_no_add_success',
          conversationId,
          cartAddPendingGate: signals.cartAddPendingGate,
        })
      );
    } else {
    try {
      const business = ctx.business as Parameters<typeof tryPresentComplementSuggestions>[0]['business'];
      const draft = await prisma.draft_order.findFirst({
        where: { business_id: businessId, customer_phone: customerPhone, status: 'active' },
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          draft_order_item: {
            orderBy: { id: 'desc' },
            take: 1,
            select: { product_id: true },
          },
        },
      });
      const lastProductId = productIdPersistedForComplement({
        lastAddedProductId: signals.lastAddedProductId,
        draftProductId: draft?.draft_order_item[0]?.product_id ?? null,
      });
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
          llmProse: signals.cartMutatedThisTurn ? null : llmProse,
        });
        if (listMsg) {
          console.debug(
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
        console.debug(
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
        console.debug(
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

  // Post-nota: la lista (total + ola viva + gestión) reemplaza la prosa del modelo.
  // Si el mismo turno sumó al carrito, el cierre del alta ya trae esas guías.
  if (signals.itemNoteSaved && !signals.cartAddSucceeded) {
    try {
      const customer = ctx.customer as { id: string };
      const noteList = await presentItemNoteSuccessList({
        conversationId,
        businessId,
        customerPhone,
        customerId: customer.id,
        metadata: ctx.conversationState?.metadata,
        itemNames: signals.itemNoteItemNames,
        note: signals.itemNoteText,
      });
      if (noteList) {
        console.debug(
          JSON.stringify({
            event: '[hybrid-agent] item_note_success_list',
            conversationId,
          })
        );
        return {
          kind: 'response',
          handlerResult: markHybridResult({
            content: noteList,
            isInteractive: true,
          }),
        };
      }
    } catch (err) {
      console.error('[hybrid-agent] item_note_success_list failed, falling through', err);
    }
  }

  if (signals.presentCart) {
    const skipCartForPendingAdd =
      signals.cartAddPendingGate && !signals.cartAddSucceeded;
    const skipCartForComplementBlock =
      signals.cartAddComplementBlocked &&
      !signals.cartAddSucceeded &&
      !signals.markComplementRefused;
    if (skipCartForPendingAdd || skipCartForComplementBlock) {
      console.debug(
        JSON.stringify({
          event: '[hybrid-agent] present_cart_skipped_pending_add_gate',
          conversationId,
          cartAddPendingGate: signals.cartAddPendingGate,
          cartAddComplementBlocked: signals.cartAddComplementBlocked,
          markComplementRefused: signals.markComplementRefused,
        })
      );
    } else {
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
        llmProse,
      });
      console.debug(JSON.stringify({ event: '[hybrid-agent] present_cart_signal', conversationId }));
      return { kind: 'response', handlerResult: markHybridResult({ content: cartMsg, isInteractive: true }) };
    } catch (err) {
      console.error('[hybrid-agent] present_cart failed, falling through', err);
    }
    }
  }

  // Add falló con pending (cantidad/variación): mostrá el ask de la tool, no prosa/cart.
  if (
    signals.cartAddPendingGate &&
    !signals.cartAddSucceeded &&
    signals.cartAddPendingAskMessage
  ) {
    console.debug(
      JSON.stringify({
        event: '[hybrid-agent] surface_add_pending_ask',
        conversationId,
      })
    );
    return {
      kind: 'response',
      handlerResult: markHybridResult({
        content: ensureWhatsAppBotFormat(signals.cartAddPendingAskMessage),
        isInteractive: false,
        skipBodyHumanization: true,
      }),
    };
  }

  // Una escritura exitosa tiene precedencia sobre la prosa del modelo: el
  // resumen lee el draft persistido y evita confirmar cantidades del request.
  if (signals.cartMutatedThisTurn) {
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
        llmProse: null,
      });
      console.debug(JSON.stringify({ event: '[hybrid-agent] post_effect_cart_summary', turnId: ctx.turnId, conversationId }));
      return { kind: 'response', handlerResult: markHybridResult({ content: cartMsg, isInteractive: true }) };
    } catch (err) {
      console.error('[hybrid-agent] post-effect cart summary failed, falling through', err);
    }
  }

  if (signals.cartAddFailed && !signals.cartAddSucceeded) {
    return {
      kind: 'response',
      handlerResult: markHybridResult({
        content: formatBotUserMessage(
          'No pude confirmar el agregado',
          '⚠️',
          'La tool no confirmó que el producto se haya agregado al pedido.'
        ),
        isInteractive: false,
      }),
    };
  }

  if (signals.cartAddUnknown) return null;

  if (signals.successfulEffectCount > 0) {
    if (signals.nextQuantityTarget) {
      const target = signals.nextQuantityTarget;
      return {
        kind: 'response',
        handlerResult: markHybridResult({
          content: formatBotUserMessage(
            `¿Cuántas unidades de ${target.hint} querés?`,
            '🔢',
            `La cantidad de *${target.hint}* todavía no está confirmada.`
          ),
          isInteractive: false,
        }),
      };
    }
    return {
      kind: 'response',
      handlerResult: markHybridResult({
        content: formatBotUserMessage('Listo', '✅', 'El cambio quedó guardado.'),
        isInteractive: false,
      }),
    };
  }

  // Varias presentaciones del turno (categoría y/o CTA) salen en el orden de
  // tool_calls: la primera es el mensaje, el resto followUps. Un CTA solo sigue
  // más abajo, después del saludo, para no cambiar ese caso.
  const deferSingleProductCta =
    signals.presentationCommands.length === 1 &&
    signals.presentationCommands[0]?.type === 'product_cta';

  if (!deferSingleProductCta && signals.presentationCommands.length > 0) {
    const ctaFeatureOnEarly =
      isHybridCtaEnabled() && isHybridCtaEnabledForBusiness(businessId);
    const presentationProse = llmProse?.trim() ? ensureWhatsAppBotFormat(llmProse) : '';
    const packed = await composeOrderedPresentations(
      signals.presentationCommands,
      {
        ctx,
        businessId,
        conversationId,
        formattedText: presentationProse,
        userMessage: ctx.message?.text?.body ?? '',
        detectedProductName: ctx.detection?.detectedProductName ?? null,
        detectionQuantity: ctx.detection?.quantity ?? null,
        lastReferencedProductId:
          (ctx.conversation as { lastReferencedProductId?: string | null })
            .lastReferencedProductId ?? null,
      },
      {
        ctaFeatureOn: ctaFeatureOnEarly,
        cartAddSucceeded: signals.cartAddSucceeded,
      }
    );
    if (packed) {
      return { kind: 'response', handlerResult: packed };
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
    console.debug(JSON.stringify({ event: '[hybrid-agent] present_address_confirmation_signal', conversationId }));
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
        console.debug(JSON.stringify({ event: '[hybrid-agent] present_welcome_options_signal', conversationId }));
        await clearWelcomeEligible(conversationId);
        return { kind: 'response', handlerResult: markHybridResult({ content: menu, isInteractive: true }) };
      }
    } catch (err) {
      console.error('[hybrid-agent] present_welcome_options failed, falling through', err);
    }
  }

  const rawText = llmProse;
  if (!rawText) return null;

  guardJsonRegression(rawText, ctx.conversationId);

  const formattedText = ensureWhatsAppBotFormat(rawText);
  const userMessage = ctx.message?.text?.body ?? '';

  const detectedProductName = ctx.detection?.detectedProductName ?? null;
  const ctaFeatureOn =
    isHybridCtaEnabled() && isHybridCtaEnabledForBusiness(businessId);

  // Un solo present_product_cta: mismo camino de antes (intro = prosa del modelo).
  // Si ya sumó al carrito en este turno, no reabrir shortlist (evita «Sumé» + lista).
  if (
    deferSingleProductCta &&
    signals.presentProductCta &&
    ctaFeatureOn &&
    !signals.cartAddSucceeded
  ) {
    const handlerResult = await materializeProductCtaPresentation(signals.presentProductCta, {
      ctx,
      businessId,
      conversationId,
      formattedText,
      userMessage,
      detectedProductName,
      detectionQuantity: ctx.detection?.quantity ?? null,
      lastReferencedProductId:
        (ctx.conversation as { lastReferencedProductId?: string | null }).lastReferencedProductId ??
        null,
    });
    if (handlerResult) {
      return { kind: 'response', handlerResult: markHybridResult(handlerResult) };
    }
  } else if (
    deferSingleProductCta &&
    signals.presentProductCta &&
    signals.cartAddSucceeded
  ) {
    console.debug(
      JSON.stringify({
        event: '[hybrid-cta] cta_skipped',
        reason: 'cart_add_same_turn',
        conversationId,
      })
    );
  } else if (deferSingleProductCta && signals.presentProductCta) {
    console.debug(
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
