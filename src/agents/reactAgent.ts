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
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { DynamicStructuredTool } from '@langchain/core/tools';
import {
  HumanIntentToolNode,
  canonicalRecoveryOrderLineId,
  completesTask,
  isFailClosedTaskRejection,
  requiresUserInput,
} from './humanIntentToolNode';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import { z } from 'zod';
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
import { allReactTools, setOrderLineQuantityTool } from '../tools';
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
import { getRequestedPartySize, normalizeMetadata } from '../services/productQuery/utils';
import { getPendingOrderLines, getTaskCanonicalResolution } from '../services/pendingOrderLines.service';
import { deriveOrderQuantityGoalTarget } from '../services/orderQuantityGoal.service';
import { hasActivePedirHumanIntent } from '../services/partySizeGoal.service';
const markHybridResult = (result: HandlerResult): HandlerResult => ({
  ...result,
  skipBodyHumanization: true,
});

let cachedAgents = new Map<string, ReturnType<typeof createReactAgent>>();

const diagnosticValue = (value: unknown, maxLength = 2400): string => {
  let serialized: string;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  } catch {
    serialized = String(value);
  }
  return serialized.length > maxLength
    ? `${serialized.slice(0, maxLength)}…[truncated]`
    : serialized;
};

class ReactCycleTraceCallback extends BaseCallbackHandler {
  name = 'react-cycle-trace';
  private iteration = 0;
  private messageIndex: number;
  private readonly loggedToolCallIds = new Set<string>();

  constructor(
    private readonly turnId: string | undefined,
    private readonly conversationId: string,
    initialMessageCount: number
  ) {
    super();
    this.messageIndex = initialMessageCount;
  }

  handleLLMEnd(output: LLMResult): void {
    const message = output.generations[0]?.[0];
    if (!message || !('message' in message) || !(message.message instanceof AIMessage)) return;

    this.iteration += 1;
    const toolCalls = message.message.tool_calls ?? [];
    const traceId = `${this.conversationId}:${this.turnId ?? 'no-turn'}`;
    console.log(JSON.stringify({
      event: `[REACT ${this.iteration}]`,
      turnId: this.turnId,
      conversationId: this.conversationId,
      iteration: this.iteration,
      messageIndex: this.messageIndex++,
      type: 'AIMessage',
      terminal: toolCalls.length === 0,
      content: message.message.content,
      tool_calls: toolCalls.map((call) => ({
        id: call.id ?? null,
        name: call.name ?? null,
        args: call.args ?? null,
      })),
      invalid_tool_calls: message.message.invalid_tool_calls ?? [],
    }));
    for (const call of toolCalls) {
      const args = (call.args ?? {}) as Record<string, unknown>;
      console.log(JSON.stringify({
        event: '[TRACE-ORDERLINE]',
        stage: 'AIMessage.tool_call',
        traceId,
        conversationId: this.conversationId,
        turnId: this.turnId ?? null,
        toolCallId: typeof call.id === 'string' ? call.id : null,
        toolName: typeof call.name === 'string' ? call.name : null,
        rawArgs: {
          orderLineId: typeof args.orderLineId === 'string' ? args.orderLineId : null,
          productId: typeof args.productId === 'string' ? args.productId : null,
          resolutionId: typeof args.resolutionId === 'string' ? args.resolutionId : null,
          quantity: typeof args.quantity === 'number' ? args.quantity : null,
        },
      }));
    }
  }

  handleChainEnd(outputs: Record<string, unknown>): void {
    const messages = outputs.messages;
    if (!Array.isArray(messages)) return;

    for (const message of messages) {
      if (!(message instanceof ToolMessage)) continue;
      const toolCallId = message.tool_call_id;
      if (this.loggedToolCallIds.has(toolCallId)) continue;
      this.loggedToolCallIds.add(toolCallId);
      console.log(JSON.stringify({
        event: `[TOOLS ${this.iteration}]`,
        turnId: this.turnId,
        conversationId: this.conversationId,
        iteration: this.iteration,
        messageIndex: this.messageIndex++,
        type: 'ToolMessage',
        tool_call_id: toolCallId,
        name: message.name ?? null,
        result: diagnosticValue(message.content),
      }));
      let payload: Record<string, unknown> | null = null;
      if (typeof message.content === 'string') {
        try {
          const parsed = JSON.parse(message.content) as unknown;
          payload = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
        } catch {
          payload = null;
        }
      }
      const orderLine = payload?.orderLine as { id?: unknown; requestedQuantity?: unknown } | undefined;
      console.log(JSON.stringify({
        event: '[TRACE-ORDERLINE]',
        stage: 'ToolMessage.after_tool',
        traceId: `${this.conversationId}:${this.turnId ?? 'no-turn'}`,
        conversationId: this.conversationId,
        turnId: this.turnId ?? null,
        toolCallId: toolCallId || null,
        toolName: message.name ?? null,
        success: payload?.success === true,
        error: typeof payload?.error === 'string' ? payload.error : null,
        orderLineId: typeof payload?.orderLineId === 'string'
          ? payload.orderLineId
          : typeof orderLine?.id === 'string'
            ? orderLine.id
            : null,
        resolutionId: typeof payload?.resolutionId === 'string' ? payload.resolutionId : null,
        quantity: typeof payload?.quantity === 'number'
          ? payload.quantity
          : typeof orderLine?.requestedQuantity === 'number'
            ? orderLine.requestedQuantity
            : null,
      }));
    }
  }
}

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
    const availableTools = [
      ...allReactTools,
      startAddressEditSessionTool,
      ...(checkoutDelegation ? [startCheckoutSessionTool] : []),
      ...(reservationDelegation ? [startReservationSessionTool] : []),
    ];
    const tools = requiredToolChoice === 'set_order_line_quantity'
      ? availableTools.map((tool) => {
          if (tool.name !== 'set_order_line_quantity') return tool;
          const boundQuantityTool = new DynamicStructuredTool({
                name: tool.name,
                description:
                  'Persiste la cantidad confirmada para el target del Quantity Goal activo. ' +
                  'El sistema vincula la línea; informá únicamente la cantidad confirmada por el usuario. ' +
                  'No uses partySize ni suggestedQuantity como quantity.',
                schema: z.object({
                  quantity: z.number().int().min(1).max(99)
                    .describe('Unidades confirmadas por el usuario para la línea indicada por el Goal.'),
                }),
                func: async (input, _runManager, config) => {
                  const { quantity } = z.object({
                    quantity: z.number().int().min(1).max(99),
                  }).parse(input);
                  const candidate = (config?.configurable as {
                    goalFulfillmentCandidate?: {
                      goalType?: unknown;
                      target?: { orderLineId?: unknown };
                    };
                  } | undefined)?.goalFulfillmentCandidate;
                  const orderLineId = candidate?.goalType === 'OBTENER_CANTIDAD_DEL_PRODUCTO' &&
                    typeof candidate.target?.orderLineId === 'string'
                    ? candidate.target.orderLineId
                    : undefined;
                  if (!orderLineId) {
                    return JSON.stringify({
                      success: false,
                      error: 'goal_target_missing',
                      instruction: 'El Quantity Goal no tiene un target OrderLine disponible. No intentes otra línea.',
                    });
                  }
                  return setOrderLineQuantityTool.invoke({ orderLineId, quantity }, config);
                },
              });
          // Sin returnDirect: persistir la cantidad satisface el Goal, no termina el turno.
          // Si la Task queda lista, el resultado trae nextRequiredTool = add_cart_item.
          return boundQuantityTool;
        })
      : availableTools;
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
  /** Pregunta específica cuando un ADD se difiere porque la línea sigue UNKNOWN. */
  cartAddQuantityAskMessage: string | null;
  /** Resultado ausente/no booleano: dejar que dispatch verifique el draft persistido. */
  cartAddUnknown: boolean;
  /** Effects exitosos observados en ToolMessages de este turno. */
  successfulEffectCount: number;
  /** Siguiente línea cuya cantidad UNKNOWN debe preguntarse tras un efecto. */
  nextQuantityTarget: { id: string; hint: string } | null;
  /** Cantidad de OrderLine confirmada en este turno. */
  orderLineQuantityPersisted: { hint: string; quantity: number } | null;
  /** Producto del último add_cart_item exitoso de este turno. */
  lastAddedProductId: string | null;
  /**
   * queueFollowUp del add_cart_item exitoso que cerró una OrderLine con cola
   * restante (dato determinístico del tool, no inferencia del LLM). La
   * respuesta final lo comunica; no dispara ninguna tool por sí solo — avanzar
   * la cola sigue siendo continue_order_line en un turno posterior.
   */
  queueFollowUp: { nextHint: string; remaining: number } | null;
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
    cartAddQuantityAskMessage: null,
    cartAddUnknown: false,
    successfulEffectCount: 0,
    nextQuantityTarget: null,
    orderLineQuantityPersisted: null,
    lastAddedProductId: null,
    queueFollowUp: null,
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
        const queueFollowUp = data.queueFollowUp;
        if (
          queueFollowUp &&
          typeof queueFollowUp === 'object' &&
          typeof (queueFollowUp as { nextHint?: unknown }).nextHint === 'string' &&
          typeof (queueFollowUp as { remaining?: unknown }).remaining === 'number'
        ) {
          signals.queueFollowUp = {
            nextHint: (queueFollowUp as { nextHint: string }).nextHint,
            remaining: (queueFollowUp as { remaining: number }).remaining,
          };
        }
      }
      if (m.name === 'add_cart_item' && data.success === false) {
        signals.cartAddFailed = true;
        if (data.error === 'order_line_quantity_required' && typeof data.askMessage === 'string') {
          signals.cartAddQuantityAskMessage = data.askMessage;
        }
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
      if (
        m.name === 'set_order_line_quantity' &&
        data.success === true &&
        typeof data.orderLine === 'object' &&
        data.orderLine !== null &&
        typeof (data.orderLine as { hint?: unknown }).hint === 'string' &&
        typeof (data.orderLine as { requestedQuantity?: unknown }).requestedQuantity === 'number'
      ) {
        signals.orderLineQuantityPersisted = {
          hint: (data.orderLine as { hint: string }).hint,
          quantity: (data.orderLine as { requestedQuantity: number }).requestedQuantity,
        };
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

const parseToolPayload = (msg: unknown): Record<string, unknown> | null => {
  const content = (msg as { content?: unknown }).content;
  if (typeof content !== 'string') return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * El último paso de tools de esta corrida terminó en un DEFER que necesita
 * input humano (`requiresUserInput`) y no persistió ningún efecto. Un paso con
 * un efecto exitoso sigue en manos del modelo, que debe comunicar ambos.
 */
const lastStepToolPayloads = (messages: unknown[], firstRunIndex: number): Array<Record<string, unknown> | null> => {
  const payloads: Array<Record<string, unknown> | null> = [];
  for (let index = messages.length - 1; index >= firstRunIndex; index -= 1) {
    if (messageRole(messages[index]) !== 'tool') break;
    payloads.push(parseToolPayload(messages[index]));
  }
  return payloads;
};

export const stepAwaitsUserInput = (messages: unknown[], firstRunIndex: number): boolean => {
  const stepPayloads = lastStepToolPayloads(messages, firstRunIndex);
  if (stepPayloads.some((payload) => payload?.success === true && payload.effect != null)) return false;
  return stepPayloads.some((payload) => requiresUserInput(payload));
};

/**
 * askMessage del último step de tools si ese step quedó esperando input humano
 * (mismo criterio que stepAwaitsUserInput: un efecto exitoso en el mismo step lo
 * excluye). Es la señal terminal más reciente del turno — precede a cualquier
 * señal de presentación (present_cart, queueFollowUp, confirmación genérica)
 * acumulada antes, sin importar qué tool la produjo ni su posición en el array.
 */
export const lastStepAskMessage = (messages: unknown[], firstRunIndex: number): string | null => {
  if (!stepAwaitsUserInput(messages, firstRunIndex)) return null;
  const hit = lastStepToolPayloads(messages, firstRunIndex)
    .find((payload): payload is { askMessage: string } => requiresUserInput(payload));
  return hit?.askMessage ?? null;
};

/** Por qué termina el turno tras el último paso de tools, o null si el modelo sigue. */
export const stepEndsTurn = (
  messages: unknown[],
  firstRunIndex: number
): 'fulfillment_completed' | 'awaits_user_input' | 'task_recovery_failed' | null => {
  const stepPayloads: Array<Record<string, unknown> | null> = [];
  let stepStart = messages.length;
  for (let index = messages.length - 1; index >= firstRunIndex; index -= 1) {
    if (messageRole(messages[index]) !== 'tool') break;
    stepPayloads.push(parseToolPayload(messages[index]));
    stepStart = index;
  }
  if (stepPayloads.some((payload) => completesTask(payload))) return 'fulfillment_completed';
  if (stepAwaitsUserInput(messages, firstRunIndex)) return 'awaits_user_input';
  // Rechazo de resolución Task-bound sin recuperación, o la recuperación canónica de esa
  // Task ya se ofreció antes en este turno: respuesta segura en vez de reintentar.
  if (stepPayloads.some((payload) => isFailClosedTaskRejection(payload))) return 'task_recovery_failed';
  const recoveredBefore = new Set(
    messages
      .slice(firstRunIndex, stepStart)
      .filter((message) => messageRole(message) === 'tool')
      .map((message) => canonicalRecoveryOrderLineId(parseToolPayload(message)))
      .filter((orderLineId): orderLineId is string => orderLineId != null)
  );
  if (stepPayloads.some((payload) => {
    const orderLineId = canonicalRecoveryOrderLineId(payload);
    return orderLineId != null && recoveredBefore.has(orderLineId);
  })) {
    return 'task_recovery_failed';
  }
  return null;
};

/**
 * Pregunta de cantidad de la OrderLine ACTIVE cuando el Goal de cantidad está abierto
 * para ella: resolución canónica válida, cantidad desconocida y misma Task como target
 * del Goal. Todo sale del estado persistido; si algo no cierra, null (fallback seguro).
 */
export const activeLineQuantityAsk = async (
  conversationId: string,
  businessId: string
): Promise<string | null> => {
  const metadata = (await findOrCreateConversationState(conversationId)).metadata;
  const active = getPendingOrderLines(metadata)?.lines.find((line) => line.status === 'active');
  if (!active || active.requestedQuantity != null) return null;
  const canonical = getTaskCanonicalResolution(active, metadata, { businessId, conversationId });
  if (!canonical) return null;
  const normalized = normalizeMetadata(metadata);
  const target = deriveOrderQuantityGoalTarget({
    activePedir: hasActivePedirHumanIntent(normalized),
    checkoutActive: normalized.checkout_active === true,
    partySizeKnown: getRequestedPartySize(normalized) != null,
    metadata,
    businessId,
    conversationId,
  });
  if (target?.id !== active.id) return null;
  const product = await prisma.menu_item.findFirst({
    where: { id: canonical.productId, business_id: businessId },
    select: { name: true },
  });
  return product?.name ? `¿Cuántas unidades de ${product.name} querés agregar?` : null;
};

type StreamableAgent = {
  stream: (
    input: { messages: BaseMessage[] },
    options: Record<string, unknown>
  ) => Promise<AsyncIterable<{ messages?: unknown[] }> & { cancel?: (reason?: unknown) => Promise<void> }>;
};

/**
 * Equivalente a `agent.invoke` (el último estado de `streamMode: 'values'`),
 * pero termina el turno apenas un paso de tools pide input humano o completa
 * el fulfillment de una Task: cancela el grafo antes de otra llamada al
 * modelo, sin depender del recursionLimit.
 */
export const runAgentUntilUserInput = async (
  agent: StreamableAgent,
  inputs: { messages: BaseMessage[] },
  options: Record<string, unknown>,
  trace: { conversationId?: string; turnId?: string } = {}
): Promise<{ messages?: unknown[] }> => {
  const stream = await agent.stream(inputs, { ...options, streamMode: 'values' });
  let finalState: { messages?: unknown[] } = { messages: inputs.messages };
  for await (const state of stream) {
    finalState = state;
    const endReason = stepEndsTurn(state.messages ?? [], inputs.messages.length);
    if (endReason) {
      console.log(JSON.stringify({
        event: endReason === 'fulfillment_completed'
          ? '[hybrid-agent] turn_ends_after_fulfillment'
          : endReason === 'task_recovery_failed'
            ? '[hybrid-agent] turn_ends_task_recovery_failed'
            : '[hybrid-agent] turn_awaits_user_input',
        conversationId: trace.conversationId ?? null,
        turnId: trace.turnId ?? null,
      }));
      // break solo libera el reader externo; cancel() aborta los pasos pendientes del grafo.
      await stream.cancel?.('awaiting_user_input');
      break;
    }
  }
  return finalState;
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
  const reactCycleTrace = new ReactCycleTraceCallback(
    ctx.turnId,
    conversationId,
    inputs.messages.length
  );
  const out = await runAgentUntilUserInput(agent as unknown as StreamableAgent, inputs, {
    recursionLimit: 12,
    callbacks: [reactCycleTrace],
    configurable: {
      businessId,
      customerId,
      customerPhone,
      conversationId,
      conversationStartedAt,
      turnStartedAt,
      turnId: ctx.turnId,
      userMessage: userMessageForTools,
      activeBlockingGoal,
      goalFulfillmentCandidate: fulfillmentCandidate,
      ...(fulfillmentCandidate?.goalType === 'OBTENER_CANTIDAD_DEL_PRODUCTO' && typeof fulfillmentCandidate.target?.orderLineId === 'string'
        ? { orderLineId: fulfillmentCandidate.target.orderLineId }
        : {}),
      ...(typeof ctx.humanIntentGateRevision === 'number'
        ? { humanIntentGateRevision: ctx.humanIntentGateRevision }
        : {}),
    },
  }, { conversationId, turnId: ctx.turnId });

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
  // Rechazo de resolución Task-bound sin recuperación: respuesta segura, nunca silencio
  // ni confirmación falsa (el add no ocurrió). Si la Task ACTIVE espera su cantidad,
  // la siguiente pregunta correcta sale del estado persistido, no de la operación rechazada.
  if (
    !signals.cartAddSucceeded &&
    stepEndsTurn(agentMessages, inputs.messages.length) === 'task_recovery_failed'
  ) {
    const activeAsk = await activeLineQuantityAsk(conversationId, businessId);
    if (activeAsk) {
      return {
        kind: 'response',
        handlerResult: markHybridResult({
          content: formatBotUserMessage('¿Cuántas unidades?', '🔢', activeAsk),
          isInteractive: false,
        }),
      };
    }
    return {
      kind: 'response',
      handlerResult: markHybridResult({
        content: formatBotUserMessage(
          'No pude confirmar el agregado',
          '⚠️',
          'No pude completar la carga de ese producto en este momento. Intentemos nuevamente.'
        ),
        isInteractive: false,
      }),
    };
  }
  // Precedencia de respuesta terminal: si el último step de tools de este turno quedó
  // esperando input humano (mismo criterio que corta el grafo en runAgentUntilUserInput),
  // esa pregunta es la respuesta, sin importar qué señales de presentación (present_cart,
  // queueFollowUp, confirmaciones genéricas) se hayan acumulado antes en el mismo turno.
  // Un step con efecto exitoso + askMessage no entra acá (lastStepAskMessage ya lo excluye).
  if (!signals.cartAddSucceeded) {
    const terminalAskMessage = lastStepAskMessage(agentMessages, inputs.messages.length);
    if (terminalAskMessage) {
      return {
        kind: 'response',
        handlerResult: markHybridResult({
          content: formatBotUserMessage('¿Cuántas unidades?', '🔢', terminalAskMessage),
          isInteractive: false,
        }),
      };
    }
  }
  // "Cantidad anotada" solo si la cantidad quedó persistida sin fulfillment posterior
  // en este turno: un add exitoso (resumen de carrito) o un ask del add tienen su propia rama.
  if (
    signals.orderLineQuantityPersisted &&
    !signals.cartAddSucceeded &&
    !signals.cartAddQuantityAskMessage &&
    !signals.cartAddPendingAskMessage
  ) {
    const { hint, quantity } = signals.orderLineQuantityPersisted;
    return {
      kind: 'response',
      handlerResult: markHybridResult({
        content: formatBotUserMessage(
          'Cantidad anotada',
          '✅',
          `Anoté ${quantity} unidades de ${hint}.`,
        ),
        isInteractive: false,
        skipBodyHumanization: true,
      }),
    };
  }
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
      // queueFollowUp es un dato determinístico del add_cart_item que cerró la OrderLine
      // (no una inferencia del LLM): si queda cola, la respuesta la comunica acá y el
      // turno igual termina — avanzar la cola sigue siendo continue_order_line en otro turno.
      const followUpProse = signals.queueFollowUp && signals.queueFollowUp.remaining > 0
        ? signals.queueFollowUp.remaining === 1
          ? `Queda 1 línea de tu pedido por sumar. ¿Seguimos con *${signals.queueFollowUp.nextHint}*?`
          : `Quedan ${signals.queueFollowUp.remaining} línea(s) de tu pedido por sumar. ` +
            `¿Seguimos con *${signals.queueFollowUp.nextHint}*?`
        : null;
      const cartMsg = await buildCartSummaryMessage({
        businessId,
        customerPhone,
        conversationId,
        customerId: customer.id,
        currencyCode: business.currency_code ?? null,
        businessStreetAddress: business.street_address ?? null,
        llmProse: null,
      });
      // El CTA de continuación va al final absoluto del mensaje (estado del carrito primero,
      // propuesta de seguir después), no antepuesto via llmProse como el resto de la prosa.
      // No muta cartMsg: buildCartSummaryMessage puede devolver una referencia reutilizada.
      const cartMsgWithFollowUp = followUpProse
        ? { ...cartMsg, body: { ...cartMsg.body, text: `${cartMsg.body.text}\n\n${followUpProse}` } }
        : cartMsg;
      console.debug(JSON.stringify({ event: '[hybrid-agent] post_effect_cart_summary', turnId: ctx.turnId, conversationId }));
      return { kind: 'response', handlerResult: markHybridResult({ content: cartMsgWithFollowUp, isInteractive: true }) };
    } catch (err) {
      console.error('[hybrid-agent] post-effect cart summary failed, falling through', err);
    }
  }

  if (signals.cartAddFailed && !signals.cartAddSucceeded) {
    if (signals.cartAddQuantityAskMessage) {
      return {
        kind: 'response',
        handlerResult: markHybridResult({
          content: formatBotUserMessage(
            '¿Cuántas unidades?',
            '🔢',
            signals.cartAddQuantityAskMessage
          ),
          isInteractive: false,
        }),
      };
    }
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
  if (rawText) guardJsonRegression(rawText, ctx.conversationId);

  const formattedText = rawText ? ensureWhatsAppBotFormat(rawText) : '';
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

  if (!rawText && signals.successfulEffectCount > 0) {
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

  if (!rawText) return null;

  return {
    kind: 'response',
    handlerResult: markHybridResult({
      content: formattedText,
      isInteractive: false,
    }),
  };
};
