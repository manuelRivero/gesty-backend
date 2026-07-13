/**
 * Nodo dedicado a resolver la confirmación de una dirección que el híbrido
 * dejó "staged" al responder una pregunta de envío delegada desde otra
 * sesión (o sin sesión alguna) — ver `stage_delivery_address` /
 * `present_address_confirmation` en `reactAgent.ts` y
 * `AddressService.stageAddressForDelegatedConfirmation`.
 *
 * `context/index.ts` prioriza este nodo sobre checkout/onboarding/reservas
 * mientras `pending_address_confirmation` esté en metadata, para que el
 * próximo turno del cliente (botón o texto libre) siempre resuelva la
 * confirmación primero, sin importar qué otra sesión esté activa debajo.
 *
 * Resuelto (confirmado o no), si el checkout sigue activo se retoma su paso
 * pendiente (H-03, mismo patrón que `buildResumeFollowUp` en checkout/onboarding).
 */

import { AddressService } from '../../../services/address.service';
import { textResponse } from '../../../controllers/webhook/utils';
import { normalizeMetadata } from '../../../services/productQuery/utils';
import { extractPendingTurnResponse } from '../../../services/ai/extractPendingTurnResponse';
import {
  ConfirmAddressPendingSchema,
  CONFIRM_ADDRESS_QUESTION,
  CONFIRM_ADDRESS_VALUE_HINTS,
  CONFIRM_ADDRESS_ACTION_DESCRIPTION,
} from '../../../agents/onboardingAgent';
import { delegateToMainWithDetection } from './delegateToMain';
import { runHybridReactAgent } from '../../../agents/reactAgent';
import { detectIntentWithConfidence } from '../../../services/ai/detection.service';
import { findOrCreateConversationState } from '../../../repositories';
import { getDraftCheckoutState } from '../../../tools/checkout';
import { buildPaymentButtonsMessage } from '../checkout';
import { nextCheckoutStep } from '../../../services/checkout/nextCheckoutStep';
import { resolveCheckoutPendingFromStep } from '../../../services/checkout/checkoutGoal.service';
import { buildFulfillmentSelectionMessage } from '../gates/fulfillmentSelection';
import { buildOrderConfirmationMessage } from '../../../services/checkout/orderConfirmationMessage';
import type { AgentState, AgentStateUpdate } from '../../state';
import type { EnrichedContext, HandlerResult } from '../../../controllers/webhook/types';

const addressService = new AddressService();

/** Re-arma la tarjeta de confirmación con el texto staged actual (re-mostrar tras reprompt/delegate). */
const rebuildConfirmationCard = (
  addressText: string | null,
  leadingText?: string
): HandlerResult => {
  const body = addressText
    ? `📍 Encontré esta dirección:\n${addressText}\n\n¿Es correcta?`
    : '📍 ¿Es correcta la dirección que compartiste?';
  const card = addressService.buildDelegatedConfirmAddressMessage(
    leadingText ? `${leadingText}\n\n${body}` : body
  );
  return { content: card, isInteractive: true, skipBodyHumanization: true };
};

/**
 * Si el checkout sigue activo, arma el mensaje/botones del paso pendiente
 * real (mismo criterio que `resolveCheckoutAgentHandlerResult` en
 * `checkout/index.ts`) para retomar el pedido después de resolver la
 * dirección. `null` si el checkout no está activo o no hay nada pendiente.
 */
const buildCheckoutResumeResult = async (params: {
  checkoutActive: boolean;
  businessId: string;
  customerId: string;
  customerPhone: string;
  customerName: string | null;
  currencyCode: string | null;
  hasAddress: boolean;
  isInCoverage: boolean;
  leadingText: string;
}): Promise<HandlerResult | null> => {
  if (!params.checkoutActive) return null;

  const draftState = await getDraftCheckoutState(params.businessId, params.customerPhone);
  const step = nextCheckoutStep(
    {
      fulfillmentType: draftState.fulfillmentType,
      hasAddress: params.hasAddress,
      isInCoverage: params.isInCoverage,
      customerName: params.customerName,
      paymentMethod: draftState.paymentMethod,
    },
    { deliveryEnabled: true, takeawayEnabled: true }
  );
  const pending = resolveCheckoutPendingFromStep(step);
  const resumeText = pending.question
    ? `${params.leadingText}\n\nVolviendo a tu pedido: ${pending.question}`
    : params.leadingText;

  if (pending.action === 'fulfillment_type') {
    return { content: buildFulfillmentSelectionMessage(resumeText), isInteractive: true };
  }
  if (pending.action === 'payment_method') {
    return { content: buildPaymentButtonsMessage(resumeText), isInteractive: true };
  }
  if (pending.action === 'confirm_order' && draftState.paymentMethod) {
    const confirmMessage = await buildOrderConfirmationMessage({
      businessId: params.businessId,
      customerId: params.customerId,
      customerPhone: params.customerPhone,
      paymentMethod: draftState.paymentMethod,
      currencyCode: params.currencyCode,
      leadingText: params.leadingText,
    });
    if (confirmMessage) {
      return { content: confirmMessage, isInteractive: true };
    }
  }

  return textResponse(resumeText);
};

/**
 * Sin checkout activo, "qué sigue" es responsabilidad del híbrido, no de
 * este nodo (ADR-0002: ningún agente de dominio compone su propia respuesta
 * general — ver misma decisión en `onboardingAgentNode`). Si hay un carrito
 * con ítems, el híbrido ya trae el Goal COMPLETAR_PEDIDO
 * (`orderCompletionGoal.service.ts`) para ofrecer continuar el pedido,
 * con su propio presupuesto anti-insistencia — no se duplica esa lógica acá.
 */
const invokeHybridAfterAddressSaved = async (params: {
  enrichedBase: EnrichedContext;
  conversationId: string;
  detectionContext: AgentState['detectionContext'];
  userMessage: string;
  fallbackText: string;
}): Promise<HandlerResult> => {
  const { enrichedBase, conversationId, detectionContext, userMessage, fallbackText } = params;
  const fallback = textResponse(fallbackText) ?? { content: fallbackText, isInteractive: false };
  if (!detectionContext || !userMessage.trim()) return fallback;

  try {
    const freshState = await findOrCreateConversationState(conversationId);
    const hybrid = await runHybridReactAgent({
      ...enrichedBase,
      detection: await detectIntentWithConfidence(userMessage, detectionContext),
      conversationState: freshState,
    });
    return hybrid?.kind === 'response' ? hybrid.handlerResult : fallback;
  } catch (err) {
    console.error('[delegated-address-confirmation] error invocando híbrido tras guardar dirección:', err);
    return fallback;
  }
};

export const delegatedAddressConfirmationNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const ctx = state.webhookContext!;
  const enrichedBase = state.enrichedCtx as unknown as EnrichedContext;
  const conversation = state.conversation!;
  const business = state.business!;
  const customer = state.customer!;
  const conversationId = conversation.id;
  const customerPhone = customer.phone_number ?? ctx.to;
  const customerName = (customer as { name?: string | null }).name?.trim() || null;
  const wsMeta = normalizeMetadata(state.workingConversationState?.metadata);
  const checkoutActive = wsMeta.checkout_active === true;
  const currencyCode = (business as { currency_code?: string | null }).currency_code ?? null;

  const resolveAndRespond = async (
    confirmed: boolean,
    leadingText?: string
  ): Promise<AgentStateUpdate> => {
    const resultText = await addressService.resolveDelegatedAddressConfirmation(
      enrichedBase,
      confirmed
    );
    const combinedLeading = leadingText ? `${leadingText}\n\n${resultText}` : resultText;

    const resume = await buildCheckoutResumeResult({
      checkoutActive,
      businessId: business.id,
      customerId: customer.id,
      customerPhone,
      customerName,
      currencyCode,
      // La dirección recién resuelta ya está guardada al momento de calcular
      // el resume (resolveDelegatedAddressConfirmation corre antes) — el
      // próximo `state.hasAddress`/`isInCoverage` (turno siguiente) la vería,
      // pero acá conviene asumir "confirmed" como señal directa para no
      // depender de una relectura extra en el mismo turno.
      hasAddress: confirmed || state.hasAddress,
      isInCoverage: confirmed || state.isInCoverage,
      leadingText: combinedLeading,
    });

    if (resume) {
      return { handlerResult: resume, dataCollectionDelegated: true };
    }

    if (!confirmed) {
      // Rechazó/pidió editar: nada que continuar, solo el pedido de la
      // dirección correcta — no tiene sentido delegarle esto al híbrido.
      return { handlerResult: textResponse(combinedLeading), dataCollectionDelegated: true };
    }

    // Confirmó y no hay checkout activo: delegarle al híbrido "qué sigue"
    // (puede ofrecer continuar el pedido vía COMPLETAR_PEDIDO si hay
    // carrito) en vez de devolver siempre el mismo ack plano.
    const finalResult = await invokeHybridAfterAddressSaved({
      enrichedBase,
      conversationId,
      detectionContext: state.detectionContext,
      userMessage: ctx.message?.text?.body?.trim() ?? '',
      fallbackText: combinedLeading,
    });
    return { handlerResult: finalResult, dataCollectionDelegated: true };
  };

  if (ctx.payloadId === 'DELEGATED_CONFIRM_ADDRESS') {
    return resolveAndRespond(true);
  }
  if (ctx.payloadId === 'DELEGATED_EDIT_ADDRESS') {
    return resolveAndRespond(false);
  }

  const userText = ctx.message?.text?.body?.trim() ?? '';
  const pendingAddressText =
    typeof wsMeta.pending_address_text === 'string' ? wsMeta.pending_address_text : null;

  if (!userText) {
    return {
      handlerResult: rebuildConfirmationCard(pendingAddressText),
      dataCollectionDelegated: true,
    };
  }

  const extraction = await extractPendingTurnResponse({
    userMessage: userText,
    pendingAction: 'confirm_address',
    botQuestion: CONFIRM_ADDRESS_QUESTION,
    schema: ConfirmAddressPendingSchema,
    valueHints: CONFIRM_ADDRESS_VALUE_HINTS,
    actionDescription: CONFIRM_ADDRESS_ACTION_DESCRIPTION,
  });
  console.log(
    JSON.stringify({
      event: '[delegated-address-confirmation] extraction',
      status: extraction.status,
      confidence: extraction.confidence,
      source: extraction.source,
      conversationId,
    })
  );

  if (extraction.status === 'fulfilled' && extraction.value) {
    return resolveAndRespond(extraction.value.confirmed);
  }

  if (extraction.status === 'delegate') {
    let baseText: string | undefined;
    try {
      const delegated = await delegateToMainWithDetection({
        enrichedCtx: enrichedBase,
        userMessage: userText,
        detectionContext: state.detectionContext,
      });
      if (delegated.handlerResult && typeof delegated.handlerResult.content === 'string') {
        baseText = delegated.handlerResult.content;
      }
    } catch (err) {
      console.error('[delegated-address-confirmation] error en delegate_to_main:', err);
    }
    return {
      handlerResult: rebuildConfirmationCard(pendingAddressText, baseText),
      dataCollectionDelegated: true,
    };
  }

  // reprompt / off_pending: re-mostrar la tarjeta, no hay otro paso al que "off_pending" pueda referirse acá.
  return {
    handlerResult: rebuildConfirmationCard(pendingAddressText),
    dataCollectionDelegated: true,
  };
};
