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
  findCoverageZoneForAddress,
} from '../../../repositories';
import { prisma } from '../../../lib/prisma';
import { getBusinessConfig } from '../../../services/businessConfig.service';
import { getBusinessOpenInfo } from '../../../services/businessHours.service';
import { formatInboundMessageForLog } from '../../../controllers/webhook/utils/messageLog';
import { sendTypingIndicator } from '../../../services/whatsappTypingIndicator.service';
import { normalizeMetadata } from '../../../services/productQuery/utils';
import { isCheckoutAgentEnabled, isReservationAgentEnabled, isOnboardingAgentEnabled } from '../../../config/env';
import {
  clearCheckoutSessionIfStale,
} from '../checkout';
import type { AgentState, AgentStateUpdate } from '../../state';
import type { DetectionContext } from '../../../services/ai/detection.service';
import type { EnrichedContext } from '../../../controllers/webhook/types';

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
      payloadId: (payload as unknown as Record<string, unknown>)?.payloadId,
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
  const business = state.business!;
  const businessConfig = await getBusinessConfig(business.id);
  return { businessConfig };
};

/** Nodo 4: encuentra o crea el `customer` (E.164). */
export const resolveCustomerNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const ctx = state.webhookContext!;
  const business = state.business!;
  const customer = await findOrCreateCustomer(business.id, ctx.to);
  return { customer };
};

/** Nodo 5: calcula si el negocio está abierto en su timezone. */
export const businessOpenInfoNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const business = state.business!;
  const businessConfig = state.businessConfig!;
  const businessStatus = await getBusinessOpenInfo({
    businessId: business.id,
    timezone: business.timezone,
  });

  if (!businessStatus.isOpen) {
    if (!businessConfig.operate_when_closed) {
      return { businessStatus, earlyExit: 'business_closed' };
    }
    // Bot opera aun estando cerrado; los handlers deciden qué acciones restringir
    return { businessStatus, businessClosedButOperating: true };
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
    const { message } = ctx;
    const business = state.business!;
    const customer = state.customer!;
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

    return { conversationId: conversation.id, conversation };
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
  const business = state.business!;
  const customer = state.customer!;
  const conversation = state.conversation!;

  try {
    const conversationState = await findOrCreateConversationState(conversation.id);
    const workingConversationState = conversationState;

    if (
      !businessConfig.bot_enabled ||
      workingConversationState.is_human_handled
    ) {
      console.log(
        '[Orchestrator] Bot deshabilitado (config negocio o modo humano), no se responde automáticamente',
        {
          conversationId: conversation.id,
          botEnabled: businessConfig.bot_enabled,
          isHumanHandled: workingConversationState.is_human_handled,
        }
      );
      return { earlyExit: 'bot_disabled_or_human_handled' };
    }

    const inboundMessageId = ctx.message?.id;
    if (inboundMessageId && ctx.phoneNumberId) {
      sendTypingIndicator(ctx.phoneNumberId, inboundMessageId);
    }

    const recentMessages = await findRecentMessagesForDetectionContext(
      conversation.id,
      conversation.started_at,
      5
    );

    const enrichedBase = {
      ...ctx,
      conversation,
      business,
      customer,
      conversationState,
      conversationId: conversation.id,
    };

    const csMeta = normalizeMetadata(conversationState.metadata);
    const detectionContext: DetectionContext = {
      conversationMode: conversationState.mode || 'GLOBAL',
      lastReferencedProductId: conversation.lastReferencedProductId,
      candidateProductIds: csMeta.candidateProductIds ?? null,
      recentMessages: recentMessages.map((m) => m.message),
      lastReferencedProductName: csMeta.lastReferencedProductName ?? null,
    };

    // Onboarding por estado (metadata.onboarding_step) tiene prioridad sobre
    // todo lo demás cuando el usuario no tiene dirección o está en wizard.
    let wsMeta = normalizeMetadata(workingConversationState.metadata);
    const reservation = wsMeta.reservation;
    const reservationStep = reservation?.step;
    const reservationPaused = reservation?.paused === true;
    const onboardingStep = wsMeta.onboarding_step;

    let contextRoute: AgentStateUpdate['contextRoute'];
    let hasAddress = false;
    let isInCoverage = false;

    const customerPhone = customer.phone_number ?? ctx.to;
    let checkoutActive = wsMeta.checkout_active === true;

    if (
      isCheckoutAgentEnabled() &&
      checkoutActive &&
      (await clearCheckoutSessionIfStale({
        businessId: business.id,
        phone: customerPhone,
        conversationId: conversation.id,
        checkoutActive: true,
        payloadId: ctx.payloadId,
      }))
    ) {
      checkoutActive = false;
      const refreshed = await findOrCreateConversationState(conversation.id);
      wsMeta = normalizeMetadata(refreshed.metadata);
    }

    const isCheckoutSession =
      isCheckoutAgentEnabled() &&
      !reservationStep &&
      !onboardingStep &&
      (checkoutActive || ctx.payloadId === 'CHECKOUT');

    // El agente de reservas captura cualquier turno con reservation_agent_active
    // activo, o cuando el payload es un RESERVATION_* (slot, env, confirm, etc.),
    // o cuando el payload es VIEW_RESERVATION (inicio de sesión desde botón).
    const isReservationAgentSession =
      isReservationAgentEnabled() &&
      !reservationStep &&
      !onboardingStep &&
      !isCheckoutSession &&
      (wsMeta.reservation_agent_active === true ||
        ctx.payloadId?.startsWith('RESERVATION_') === true ||
        ctx.payloadId === 'VIEW_RESERVATION');

    // El agente de onboarding captura turnos cuando la sesión ya está activa, hay un
    // step en metadata (cualquier estado del wizard), el cliente usa los botones de
    // confirmación de dirección, o está esperando ingresar una dirección en texto.
    const isOnboardingAgentSession =
      isOnboardingAgentEnabled() &&
      !reservationStep &&
      !isReservationAgentSession &&
      !isCheckoutSession &&
      (wsMeta.onboarding_agent_active === true ||
        wsMeta.onboarding_step != null ||
        ctx.payloadId === 'ONBOARDING_CONFIRM_ADDRESS' ||
        ctx.payloadId === 'ONBOARDING_EDIT_ADDRESS' ||
        (wsMeta.awaiting_address === true && ctx.message?.type === 'text'));

    if (reservationStep && !reservationPaused) {
      contextRoute = 'reservation_wizard';
    } else if (isReservationAgentSession) {
      contextRoute = 'reservation_agent';
    } else if (isOnboardingAgentSession) {
      contextRoute = 'onboarding_agent';
    } else if (onboardingStep) {
      contextRoute = 'onboarding_by_state';
    } else if (isCheckoutSession) {
      // El agente de checkout captura el turno completo (texto e interactivos)
      // y gestiona dirección, nombre, tipo de entrega y pago.
      const defaultAddress = await findDefaultCustomerAddress(customer.id);
      hasAddress = !!defaultAddress;
      if (defaultAddress) {
        const zone = await findCoverageZoneForAddress(defaultAddress.id, business.id);
        isInCoverage = zone !== null || defaultAddress.delivery_zone_id === null;
        if (zone !== null && defaultAddress.delivery_zone_id !== zone.id) {
          await prisma.customer_address.update({
            where: { id: defaultAddress.id },
            data: { delivery_zone_id: zone.id },
          });
        } else if (zone === null && defaultAddress.delivery_zone_id !== null) {
          await prisma.customer_address.update({
            where: { id: defaultAddress.id },
            data: { delivery_zone_id: null },
          });
          isInCoverage = false;
        }
      }
      contextRoute = 'checkout';
    } else {
      const defaultAddress = await findDefaultCustomerAddress(customer.id);
      hasAddress = !!defaultAddress;
      if (!defaultAddress) {
        if (wsMeta.awaiting_address && ctx.message?.type === 'text') {
          console.log('[Orchestrator] Awaiting address → capture from text');
          contextRoute = 'address_capture';
        } else {
          contextRoute = ctx.message?.type === 'interactive' ? 'interactive' : 'nlp';
          console.log(`[Orchestrator] Route: ${contextRoute} (no address, non-blocking)`);
        }
      } else {
        // Re-validar cobertura en tiempo real: las zonas pueden haber cambiado
        const zone = await findCoverageZoneForAddress(defaultAddress.id, business.id);
        if (zone !== null) {
          isInCoverage = true;
          // Actualizar delivery_zone_id si cambió (zona reorganizada o promovida)
          if (defaultAddress.delivery_zone_id !== zone.id) {
            await prisma.customer_address.update({
              where: { id: defaultAddress.id },
              data: { delivery_zone_id: zone.id },
            });
          }
        } else if (defaultAddress.delivery_zone_id !== null) {
          // La dirección tenía zona pero ya no hay intersección → marcar sin cobertura
          await prisma.customer_address.update({
            where: { id: defaultAddress.id },
            data: { delivery_zone_id: null },
          });
          isInCoverage = false;
        } else {
          // Sin location almacenada ni zone_id → asumir válida por compatibilidad con registros previos
          isInCoverage = true;
        }
        contextRoute = ctx.message?.type === 'interactive' ? 'interactive' : 'nlp';
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
      enrichedCtx: enrichedBase as unknown as EnrichedContext,
      hasAddress,
      isInCoverage,
      contextRoute,
    };
  } catch (error) {
    console.error('[Context] Error building context:', error);
    return { earlyExit: 'persist_failed' };
  }
};
