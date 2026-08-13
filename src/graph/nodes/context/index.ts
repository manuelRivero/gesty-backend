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
  findRecentMessagesForDetectionContext,
  findDefaultCustomerAddress,
  findCoverageZoneForAddress,
} from '../../../repositories';
import { touchSession } from '../../../services/sessionActivity.service';
import { prisma } from '../../../lib/prisma';
import { getBusinessConfig } from '../../../services/businessConfig.service';
import { getBusinessOpenInfo } from '../../../services/businessHours.service';
import { formatInboundMessageForLog } from '../../../controllers/webhook/utils/messageLog';
import { sendTypingIndicator } from '../../../services/whatsappTypingIndicator.service';
import { normalizeMetadata } from '../../../services/productQuery/utils';
import { isCheckoutAgentEnabled, isReservationAgentEnabled, isOnboardingAgentEnabled, isOwnerAssistantEnabled } from '../../../config/env';
import { isOwnerPhone } from '../../../services/ownerAssistant/matchOwnerPhone';
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
  const allowlist = state.businessConfig?.owner_whatsapp_phones ?? [];
  const isOwnerAssistant =
    isOwnerAssistantEnabled() &&
    isOwnerPhone(customer.phone_number ?? ctx.to, allowlist);
  return { customer, isOwnerAssistant };
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
    if (state.isOwnerAssistant) {
      return { businessStatus };
    }
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

    // Invariante: toda actividad iniciada por el usuario que llega al grafo
    // ejecuta exactamente una llamada a touchSession() acá, antes de que
    // cualquier agente o nodo de negocio (checkout/reserva/onboarding/NLP)
    // procese el evento. No llamar refresh*Timeout directamente en otro lado.
    await touchSession({
      conversationId: conversation.id,
      businessId: business.id,
      customerPhone: customer.phone_number ?? ctx.to,
    });

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
      !state.isOwnerAssistant &&
      (!businessConfig.bot_enabled || workingConversationState.is_human_handled)
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
    // @deprecated `reservation.step`/`reservation.paused` son del wizard LEGACY
    // de reservas (ver `reservation.service.ts`). Con `RESERVATION_AGENT_ENABLED=true`
    // ninguna conversación nueva genera este campo; solo puede venir de una
    // sesión de wizard ya en curso desde antes del agente.
    const reservation = wsMeta.reservation;
    const reservationStep = reservation?.step;
    const reservationPaused = reservation?.paused === true;
    const onboardingStep = wsMeta.onboarding_step;

    // Dirección staged por el híbrido al responder una pregunta de envío
    // delegada (`stage_delivery_address`, ver `AddressService`). Prioridad
    // sobre cualquier otra sesión: si no se captura acá primero, el próximo
    // mensaje del cliente (botón o "sí, es correcta") cae en la sesión que
    // esté activa debajo (checkout, onboarding) y la confirmación se pierde.
    const isPendingDelegatedAddressConfirmation = wsMeta.pending_address_confirmation === true;

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

    // Una reserva pausada (`reservation.step` presente pero `paused: true`) es,
    // por definición, una reserva que el usuario dejó de lado — no debe bloquear
    // el routing a otra sesión agéntica activa (H-02). Solo una reserva EN CURSO
    // (no pausada) tiene prioridad de ruteo.
    const reservationBlocksRouting = Boolean(reservationStep) && !reservationPaused;
    if (reservationPaused) {
      console.log(
        JSON.stringify({
          event: '[context] reservation_paused_residual',
          conversationId: conversation.id,
        })
      );
    }

    const isCheckoutSession =
      isCheckoutAgentEnabled() &&
      !reservationBlocksRouting &&
      !onboardingStep &&
      (checkoutActive || ctx.payloadId === 'CHECKOUT');

    // El agente de reservas captura cualquier turno con reservation_agent_active
    // activo, o cuando el payload es un RESERVATION_* (slot, env, confirm, etc.),
    // o cuando el payload es VIEW_RESERVATION (inicio de sesión desde botón).
    const isReservationAgentSession =
      isReservationAgentEnabled() &&
      !reservationBlocksRouting &&
      !onboardingStep &&
      !isCheckoutSession &&
      (wsMeta.reservation_agent_active === true ||
        ctx.payloadId?.startsWith('RESERVATION_') === true ||
        ctx.payloadId === 'VIEW_RESERVATION');

    // Onboarding solo con sesión/wizard explícitos o botones de confirmación.
    // NO usar `awaiting_address` solo: ese flag lo encendía el gate de carrito
    // del híbrido y robaba turnos (ver pedido → captura de dirección).
    const isOnboardingAgentSession =
      isOnboardingAgentEnabled() &&
      !reservationBlocksRouting &&
      !isReservationAgentSession &&
      !isCheckoutSession &&
      (wsMeta.onboarding_agent_active === true ||
        wsMeta.onboarding_step != null ||
        ctx.payloadId === 'ONBOARDING_CONFIRM_ADDRESS' ||
        ctx.payloadId === 'ONBOARDING_EDIT_ADDRESS');

    // Identidad del dueño gana a toda la cadena de clientes (no es sesión:
    // el teléfono está en owner_whatsapp_phones). Después, comprobante de
    // transferencia (D1): una imagen nunca es un turno de checkout/onboarding/
    // reserva normal. El guard ya cacheó la orden candidata.
    if (state.isOwnerAssistant) {
      contextRoute = 'owner_assistant';
    } else if (state.awaitingTransferProofOrder) {
      contextRoute = 'payment_proof';
    } else if (isPendingDelegatedAddressConfirmation) {
      contextRoute = 'delegated_address_confirmation';
    } else if (reservationStep && !reservationPaused) {
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
        // Exige zona real (V-21): una dirección sin `delivery_zone_id` asignado
        // NO se considera "en cobertura" solo por compatibilidad con registros
        // viejos — eso dejaba avanzar el checkout más allá del paso de
        // dirección con una dirección que `resolveDeliveryContext`/`get_cart`
        // no podía cotizar, mostrando "sin envío" en el resumen final y un
        // mensaje genérico de "no hay dirección" al preguntar el costo.
        isInCoverage = zone !== null;
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
      // Sin dirección: menú/carrito/híbrido siguen; la dirección se pide en
      // onboarding (sesión explícita) o checkout — no en address_capture acá.
      if (!defaultAddress) {
        contextRoute = ctx.message?.type === 'interactive' ? 'interactive' : 'nlp';
        console.log(`[Orchestrator] Route: ${contextRoute} (no address, non-blocking)`);
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
        }
        // Sin `zone` ni `delivery_zone_id` previo: sigue sin cobertura real
        // (V-21) — sin fallback legacy, ver nota arriba en la rama de checkout.
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
      enrichedCtx: enrichedBase as EnrichedContext,
      hasAddress,
      isInCoverage,
      contextRoute,
    };
  } catch (error) {
    console.error('[Context] Error building context:', error);
    return { earlyExit: 'persist_failed' };
  }
};
