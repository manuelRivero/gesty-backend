/**
 * Nodos de contexto del `StateGraph` principal.
 *
 * Cada función traduce un bloque del `processWebhook` original
 * (`src/controllers/webhook/orchestrator.ts`) en un nodo LangGraph que recibe
 * el estado actual y devuelve un parche parcial del mismo. La lógica imperativa
 * y los efectos secundarios (logs, accesos a Prisma) se mantienen 1:1.
 */

import {
  extractContext as extractContextFromPayload,
  isWhatsAppStatusOnlyEvent,
} from '../../../controllers/webhook/extractor';
import {
  findBusinessByPhoneNumberId,
  findOrCreateCustomer,
  createOrGetOpenConversation,
  findOrCreateConversationState,
  createConversationMessage,
  updateConversationLastMessageAt,
  clearConversationIdleTimestamps,
  findRecentMessagesForDetectionContext,
  findDefaultCustomerAddress,
} from '../../../repositories';
import { getBusinessConfig } from '../../../services/businessConfig.service';
import { getBusinessOpenInfo } from '../../../services/businessHours.service';
import { formatInboundMessageForLog } from '../../../controllers/webhook/utils/messageLog';
import type { AgentState, AgentStateUpdate } from '../../state';
import type { DetectionContext } from '../../../services/ai/detection.service';

/** Nodo 1: extrae `WebhookContext` del payload o marca early-exit. */
export const extractContextNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const payload = state.webhookPayload;

  if (!payload) {
    console.error('[Graph] Missing webhook payload');
    return { earlyExit: 'invalid_payload' };
  }

  const ctx = extractContextFromPayload(payload);
  if (ctx) {
    console.log('[Orchestrator] Extracted context:', ctx);
  }

  if (!ctx) {
    if (isWhatsAppStatusOnlyEvent(payload)) {
      console.debug(
        '[Orchestrator] Ignoring WhatsApp status/delivery event (no message)'
      );
      return { earlyExit: 'status_only_event' };
    }
    console.error('[Orchestrator] Invalid payload structure');
    console.error('[Orchestrator] Failed processing:', {
      payloadId: (payload as any)?.payloadId,
      payload,
      reason: 'invalid_payload',
      timestamp: new Date().toISOString(),
      payloadKeys: Object.keys(payload || {}),
    });
    return { earlyExit: 'invalid_payload' };
  }

  console.log('[Orchestrator] Processing message from:', ctx.to);

  return { webhookContext: ctx };
};

/** Nodo 2: resuelve el `business` por `phone_number_id` del webhook. */
export const resolveBusinessNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const ctx = state.webhookContext!;
  const business = await findBusinessByPhoneNumberId(ctx.phoneNumberId);
  if (!business) {
    console.error('[Orchestrator] Business not found:', ctx.phoneNumberId);
    return { earlyExit: 'business_not_found' };
  }
  return { business };
};

/** Nodo 3: carga la `business_config` (toggles de bot/onboarding/billing). */
export const resolveBusinessConfigNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const business = state.business as { id: string };
  const businessConfig = await getBusinessConfig(business.id);
  return { businessConfig };
};

/** Nodo 4: encuentra o crea el `customer` (E.164). */
export const resolveCustomerNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const ctx = state.webhookContext!;
  const business = state.business as { id: string };
  const customer = await findOrCreateCustomer(business.id, ctx.to);
  return { customer };
};

/** Nodo 5: calcula si el negocio está abierto en su timezone. */
export const businessOpenInfoNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const business = state.business as { id: string; timezone: string };
  const businessStatus = await getBusinessOpenInfo({
    businessId: business.id,
    timezone: business.timezone,
  });

  if (!businessStatus.isOpen) {
    return { businessStatus, earlyExit: 'business_closed' };
  }

  return { businessStatus };
};

/**
 * Nodo 6: persiste el mensaje entrante del usuario y refresca timestamps de
 * conversación. Replica `persistUserMessage` del orquestador original
 * incluyendo el mismo manejo de errores.
 */
export const persistUserMessageNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const ctx = state.webhookContext!;
  try {
    const { phoneNumberId, to, message } = ctx;
    if (!phoneNumberId || !to) {
      console.error('[Persist] Missing phoneNumberId or to');
      return { earlyExit: 'persist_failed' };
    }

    const business = await findBusinessByPhoneNumberId(phoneNumberId);
    if (!business) {
      console.error('[Persist] Business not found:', phoneNumberId);
      return { earlyExit: 'persist_failed' };
    }

    const customer = await findOrCreateCustomer(business.id, to);
    const conversation = await createOrGetOpenConversation(business.id, customer.id);

    const messageContent = formatInboundMessageForLog(message);
    const messageType =
      message && typeof message.type === 'string' ? message.type : 'unknown';

    await createConversationMessage(
      conversation.id,
      'user',
      messageContent,
      false,
      message?.id
    );

    await clearConversationIdleTimestamps(conversation.id);

    await updateConversationLastMessageAt(conversation.id);

    console.log('[Persist] Message saved:', {
      conversationId: conversation.id,
      type: messageType,
      contentPreview: messageContent.substring(0, 50),
    });

    return { conversationId: conversation.id };
  } catch (error) {
    console.error('[Persist] Error:', error);
    return { earlyExit: 'persist_failed' };
  }
};

/**
 * Nodo 7: arma el contexto enriquecido + `DetectionContext` para NLP, y
 * decide la primera ruta tras pasar todos los gates de contexto
 * (reservation wizard, onboarding por estado, captura de dirección o
 * ruta interactive/text).
 */
export const buildDetectionContextNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const ctx = state.webhookContext!;
  const businessConfig = state.businessConfig!;
  const conversationId = state.conversationId!;

  try {
    const business = await findBusinessByPhoneNumberId(ctx.phoneNumberId);
    if (!business) return { earlyExit: 'business_not_found' };

    const customer = await findOrCreateCustomer(business.id, ctx.to);
    const conversation = await createOrGetOpenConversation(business.id, customer.id);
    const conversationState = await findOrCreateConversationState(conversation.id);

    const recentMessages = await findRecentMessagesForDetectionContext(
      conversationId,
      conversation.started_at,
      5
    );

    const workingConversationState = conversationState;

    if (
      !businessConfig.bot_enabled ||
      (workingConversationState as any).is_human_handled
    ) {
      console.log(
        '[Orchestrator] Bot deshabilitado (config negocio o modo humano), no se responde automáticamente',
        {
          conversationId: conversation.id,
          botEnabled: businessConfig.bot_enabled,
          isHumanHandled: (workingConversationState as any).is_human_handled,
        }
      );
      return { earlyExit: 'bot_disabled_or_human_handled' };
    }

    const enrichedBase = {
      ...ctx,
      conversation,
      business,
      customer,
      conversationState,
      conversationId: conversation.id,
    };

    const detectionContext: DetectionContext = {
      conversationMode: (conversationState as any).mode || 'GLOBAL',
      lastReferencedProductId: (conversation as any).lastReferencedProductId,
      candidateProductIds:
        ((conversationState as any).metadata as any)?.candidateProductIds || null,
      recentMessages: recentMessages.map((m) => m.message),
      lastReferencedProductName:
        ((conversationState as any).metadata as any)?.lastReferencedProductName || null,
    };

    // Onboarding por estado (metadata.onboarding_step) tiene prioridad sobre
    // todo lo demás cuando el usuario no tiene dirección o está en wizard.
    const reservationStep = (workingConversationState as any)?.metadata?.reservation
      ?.step;
    const onboardingStep = (workingConversationState as any)?.metadata?.onboarding_step;

    let contextRoute: AgentStateUpdate['contextRoute'];

    if (reservationStep) {
      contextRoute = 'reservation_wizard';
    } else if (onboardingStep) {
      contextRoute = 'onboarding_by_state';
    } else {
      const hasAddress = await findDefaultCustomerAddress(customer.id);
      if (!hasAddress) {
        console.log('[Orchestrator] No address → start onboarding');
        contextRoute = 'address_capture';
      } else {
        contextRoute =
          ctx.message?.type === 'interactive' ? 'interactive' : 'nlp';
        if (contextRoute === 'interactive') {
          console.log('[Orchestrator] Route: Interactive');
        } else {
          console.log('[Orchestrator] Route: NLP (text message)');
        }
      }
    }

    return {
      conversation,
      customer,
      conversationState,
      workingConversationState,
      recentMessages,
      detectionContext,
      enrichedCtx: enrichedBase as any,
      hasAddress: contextRoute !== 'address_capture',
      contextRoute,
    };
  } catch (error) {
    console.error('[Context] Error building context:', error);
    return { earlyExit: 'persist_failed' };
  }
};
