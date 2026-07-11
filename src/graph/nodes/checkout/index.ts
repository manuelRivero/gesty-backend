/**
 * Nodo LangGraph del agente de checkout dedicado.
 *
 * Captura todos los turnos mientras `metadata.checkout_active` está activo
 * (texto libre e interactivos) y los delega al `checkoutAgent`.
 *
 * Responsabilidades del nodo (no del agente):
 * - Activar `checkout_active` al primer CHECKOUT.
 * - Setear `fulfillment_type` en el draft cuando llegan los payloads de botón.
 * - Ejecutar `PayCashHandler`/`PayOnlineHandler` y limpiar la sesión.
 * - Adjuntar botones interactivos cuando el agente devuelve señales.
 * - Hacer handback al flujo normal limpiando el flag.
 */

import { prisma } from '../../../lib/prisma';
import {
  omitConversationMetadataKeys,
  patchConversationMetadata,
} from '../../../repositories/conversationState.repository';
import {
  EMPTY_CART_BOT_MESSAGE,
  FULFILLMENT_TYPE_SHORT_QUESTION,
  PAYMENT_METHOD_SHORT_QUESTION,
  ADDRESS_OUT_OF_COVERAGE_BOT_MESSAGE,
} from '../../../services/productQuery/botMessages';
import { AddressService } from '../../../services/address.service';
import { textResponse } from '../../../controllers/webhook/utils';
import { buildFulfillmentSelectionMessage } from '../gates/fulfillmentSelection';
import { PayCashHandler } from '../../../controllers/webhook/handlers/payCashHandler';
import { PayOnlineHandler } from '../../../controllers/webhook/handlers/payOnlineHandler';
import { runCheckoutAgent } from '../../../agents/checkoutAgent';
import type { CheckoutAgentContext } from '../../../agents/checkoutAgent';
import { runHybridReactAgent } from '../../../agents/reactAgent';
import { delegateToMainWithDetection } from '../session/delegateToMain';
import { detectIntentWithConfidence } from '../../../services/ai/detection.service';
import { findOrCreateConversationState } from '../../../repositories';
import { isHybridAgentMode } from '../../../config/env';
import type { HandlerFollowUp, HandlerResult } from '../../../controllers/webhook/types';
import type { EnrichedContext } from '../../../controllers/webhook/types';
import type { WhatsAppInteractiveMessage } from '../../../domain/intent/whatsappTemplates';
import type { AgentState, AgentStateUpdate } from '../../state';
import type { DetectionContext } from '../../../services/ai/detection.service';
import { setDraftFulfillmentType, getDraftCheckoutState } from '../../../tools/checkout';
import { validateCheckoutResponse } from '../../../services/checkout/checkoutValidation';
import { applyCheckoutResponsePolicy } from '../../../services/checkout/checkoutResponsePolicy';
import { effectivePending } from '../../../services/checkout/effectivePending';
import { normalizeMetadata } from '../../../services/productQuery/utils';
import { buildResumeFollowUp } from '../session/buildResumeFollowUp';
import { buildDiscardedReentryMessage } from '../session/discardedSignalMessage';
import { withOrphanPayloadAsText } from '../session/orphanPayload';

// ---------------------------------------------------------------------------
// Mensaje de botones de pago (sin ajustes de precio en v1)
// ---------------------------------------------------------------------------

function buildPaymentButtonsMessage(bodyText: string): WhatsAppInteractiveMessage {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'PAY_ONLINE', title: '💳 Pago online' } },
          { type: 'reply', reply: { id: 'PAY_CASH', title: '💵 Efectivo' } },
        ],
      },
    },
  } as WhatsAppInteractiveMessage;
}

// ---------------------------------------------------------------------------
// Helper: limpiar sesión de checkout
// ---------------------------------------------------------------------------

export const clearCheckoutSession = async (conversationId: string): Promise<void> => {
  await omitConversationMetadataKeys(conversationId, [
    'checkout_active',
    'checkout_pending_action',
    'checkout_pending_question',
    'name_refusal_count',
    'address_refusal_count',
    'pending_fulfillment_action',
  ]);
};

/** Sesión de checkout huérfana: flag activo pero sin ítems en el carrito. */
export const isStaleCheckoutSession = async (params: {
  businessId: string;
  phone: string;
  checkoutActive: boolean;
  payloadId?: string;
}): Promise<boolean> => {
  if (!params.checkoutActive) return false;
  if (params.payloadId === 'CHECKOUT') return false;

  const draft = await prisma.draft_order.findFirst({
    where: {
      business_id: params.businessId,
      customer_phone: params.phone,
      status: 'active',
    },
    select: {
      draft_order_item: { select: { id: true }, take: 1 },
    },
  });

  return !draft || draft.draft_order_item.length === 0;
};

export const clearCheckoutSessionIfStale = async (params: {
  businessId: string;
  phone: string;
  conversationId: string;
  checkoutActive: boolean;
  payloadId?: string;
}): Promise<boolean> => {
  const stale = await isStaleCheckoutSession(params);
  if (!stale) return false;
  await clearCheckoutSession(params.conversationId);
  console.log(
    JSON.stringify({
      event: '[checkout-agent] stale_session_cleared',
      reason: 'checkout_active_without_cart_items',
      conversationId: params.conversationId,
    })
  );
  return true;
};

// ---------------------------------------------------------------------------
// Activar sesión + validar carrito
// ---------------------------------------------------------------------------

export const activateCheckoutSessionIfCartHasItems = async (params: {
  businessId: string;
  phone: string;
  conversationId: string;
}): Promise<HandlerResult | null> => {
  const draft = await prisma.draft_order.findFirst({
    where: {
      business_id: params.businessId,
      customer_phone: params.phone,
      status: 'active',
    },
    select: { id: true, draft_order_item: { select: { id: true } } },
  });

  if (!draft || draft.draft_order_item.length === 0) {
    return textResponse(EMPTY_CART_BOT_MESSAGE);
  }

  await patchConversationMetadata(params.conversationId, { checkout_active: true });
  return null;
};

export const applyDefaultFulfillmentIfSingleOption = async (params: {
  businessId: string;
  phone: string;
  deliveryEnabled: boolean;
  takeawayEnabled: boolean;
}): Promise<void> => {
  if (params.deliveryEnabled && !params.takeawayEnabled) {
    await setDraftFulfillmentType(params.businessId, params.phone, 'DELIVERY');
  } else if (!params.deliveryEnabled && params.takeawayEnabled) {
    await setDraftFulfillmentType(params.businessId, params.phone, 'TAKE_AWAY');
  }
};

// ---------------------------------------------------------------------------
// Handback inline → agente híbrido (mismo turno, como delegate_to_main en reservas)
// ---------------------------------------------------------------------------

const invokeHybridAfterCheckoutHandback = async (params: {
  enrichedCtx: EnrichedContext;
  conversationId: string;
  detectionContext: DetectionContext;
  userMessage: string;
}): Promise<HandlerResult | null> => {
  if (!isHybridAgentMode() || !params.userMessage.trim()) {
    return null;
  }

  const detection = await detectIntentWithConfidence(
    params.userMessage,
    params.detectionContext
  );
  const refreshedState = await findOrCreateConversationState(params.conversationId);
  const hybridCtx: EnrichedContext = {
    ...params.enrichedCtx,
    detection,
    conversationState: refreshedState,
  };

  try {
    const hybrid = await runHybridReactAgent(hybridCtx);
    if (hybrid?.kind === 'response') {
      return hybrid.handlerResult;
    }
    // No encadenar delegate_to_checkout en el mismo turno del handback.
    return null;
  } catch (err) {
    console.error('[checkout-agent] error en handback inline hybrid:', err);
    return null;
  }
};

// ---------------------------------------------------------------------------
// Resolver respuesta del agente de checkout (compartido con NLP intercept)
// ---------------------------------------------------------------------------

export const resolveCheckoutAgentHandlerResult = async (params: {
  enrichedCtx: EnrichedContext;
  checkoutCtx: CheckoutAgentContext;
  conversationId: string;
  /** Si está presente, handback_to_main re-invoca al híbrido con el mismo mensaje. */
  handbackState?: Pick<AgentState, 'detectionContext' | 'webhookContext'>;
}): Promise<HandlerResult> => {
  const { enrichedCtx, checkoutCtx, conversationId, handbackState } = params;

  let agentResult: Awaited<ReturnType<typeof runCheckoutAgent>>;
  try {
    agentResult = await runCheckoutAgent(enrichedCtx, checkoutCtx);
  } catch (err) {
    console.error('[checkout-agent] error invocando el agente de checkout:', err);
    agentResult = null;
  }

  if (!agentResult) {
    return (
      textResponse(
        '🤖\n\n*Hubo un problema* 😔\n\nNo pude procesar tu pedido en este momento. ¿Podés intentarlo de nuevo?'
      ) ?? { content: '', isInteractive: false }
    );
  }

  const { text } = agentResult;

  // ── Capa de validación de reglas de negocio ───────────────────────────────
  // El LLM puede proponer una transición conversacionalmente coherente pero
  // inválida (ej: pasar a payment sin fulfillment resuelto). Se valida contra
  // el estado real del draft (post tool-calls) antes de actuar sobre ella.
  const businessId =
    typeof enrichedCtx.business === 'object' && enrichedCtx.business
      ? (enrichedCtx.business as { id: string }).id
      : '';
  const customerPhone =
    typeof enrichedCtx.customer === 'object' && enrichedCtx.customer
      ? (enrichedCtx.customer as { phone_number?: string }).phone_number ?? enrichedCtx.to
      : enrichedCtx.to;
  const draftState = await getDraftCheckoutState(businessId, customerPhone);
  const customerName =
    typeof enrichedCtx.customer === 'object' && enrichedCtx.customer
      ? (enrichedCtx.customer as { name?: string | null }).name?.trim() || null
      : null;
  const validation = validateCheckoutResponse(
    {
      fulfillmentType: draftState.fulfillmentType,
      paymentMethod: draftState.paymentMethod,
      hasAddress: checkoutCtx.hasAddress,
      isInCoverage: checkoutCtx.isInCoverage,
      customerName,
      deliveryEnabled: checkoutCtx.deliveryEnabled,
      takeawayEnabled: checkoutCtx.takeawayEnabled,
    },
    agentResult.signals
  );
  if (!validation.valid) {
    console.log(
      JSON.stringify({
        event: '[checkout-agent] validation_corrected',
        corrections: validation.corrections,
        conversationId,
      })
    );
  }
  const signals = validation.signals;

  // ── Política de respuesta: sin señal reconocida y sin orden creada, el
  // texto libre del LLM no puede afirmar el cierre del pedido. No se analiza
  // el contenido del texto: se sustituye por un mensaje de continuación
  // determinístico basado en el estado real del draft.
  const policyResult = applyCheckoutResponsePolicy(
    { text, signals },
    {
      fulfillmentType: draftState.fulfillmentType,
      paymentMethod: draftState.paymentMethod,
      orderId: null,
    }
  );
  if (!policyResult.responseAllowed) {
    console.log(
      JSON.stringify({
        event: '[checkout-agent] response_policy_corrected',
        corrections: policyResult.corrections,
        conversationId,
      })
    );
  }
  const safeText = policyResult.text;

  // ── Señal: delegar turno al híbrido (consulta temporal) ───────────────────
  // La sesión de checkout NO se limpia: checkout_active y checkout_pending_action
  // siguen vivos y el próximo mensaje vuelve al agente de checkout por el routing
  // existente. NO se ejecuta detectIntentWithConfidence (mismo patrón que reservation/onboarding).
  if (signals.delegateToMain) {
    console.log(
      JSON.stringify({
        event: '[checkout-agent] delegate_to_main',
        reason: signals.delegateToMainReason,
        conversationId,
      })
    );
    let mainResult: HandlerResult | null = null;
    let discardedReentrySignal = false;
    try {
      // Invariante: el híbrido no inicia checkout desde una sesión activa.
      const delegated = await delegateToMainWithDetection({
        enrichedCtx,
        userMessage: handbackState?.webhookContext?.message?.text?.body?.trim() ?? '',
        detectionContext: handbackState?.detectionContext,
      });
      mainResult = delegated.handlerResult;
      discardedReentrySignal = delegated.discardedReentrySignal;
    } catch (err) {
      console.error('[checkout-agent] error en delegate_to_main:', err);
    }

    if (discardedReentrySignal) {
      // El híbrido quiso re-entrar al checkout (ej. "sumala y cobrame") en vez de
      // responder texto — anti-loop correcto, pero hay que explicarlo (H-07),
      // no responder con el texto residual del agente de sesión.
      console.log(
        JSON.stringify({
          event: '[checkout-agent] delegation_signal_discarded',
          conversationId,
        })
      );
      return { content: buildDiscardedReentryMessage('checkout'), isInteractive: false };
    }

    const baseResult = mainResult ?? { content: safeText, isInteractive: false };

    // Anexar (no reemplazar) la pregunta suspendida del checkout, si la hay,
    // para que el usuario no tenga que adivinar que el pedido sigue en curso (H-03).
    const freshState = await findOrCreateConversationState(conversationId);
    const freshMeta = normalizeMetadata(freshState.metadata);
    const pending = effectivePending({
      metadata: freshMeta,
      snapshot: {
        fulfillmentType: draftState.fulfillmentType,
        paymentMethod: draftState.paymentMethod,
      },
    });
    const resume = buildResumeFollowUp({
      kind: 'checkout',
      pendingAction: pending.action,
      pendingQuestion: pending.question,
    });
    if (!resume.text) {
      return baseResult;
    }

    // Un solo mensaje interactivo (respuesta a la consulta + resume corto como
    // body + botones), en vez de pegar el resume como texto plano y además
    // reagregar los botones como followUp aparte — repetía la misma pregunta
    // dos veces (visto en pruebas manuales contra el bot real).
    if (typeof baseResult.content === 'string' && resume.checkoutPendingAction) {
      const combinedBody = `${baseResult.content}\n\n${resume.text}`;
      const interactiveMessage =
        resume.checkoutPendingAction === 'fulfillment_type'
          ? buildFulfillmentSelectionMessage(combinedBody)
          : buildPaymentButtonsMessage(combinedBody);
      return {
        ...baseResult,
        content: interactiveMessage,
        isInteractive: true,
      };
    }

    // `baseResult` ya es interactivo (ej. el híbrido mostró un menú/lista): no
    // se le puede injertar otro set de botones al mismo body — se anexan los
    // botones de fulfillment/pago como followUp aparte, como antes.
    const resumeFollowUps: HandlerFollowUp[] = [];
    if (resume.checkoutPendingAction === 'fulfillment_type') {
      resumeFollowUps.push({
        type: 'interactive',
        message: buildFulfillmentSelectionMessage(resume.text) as WhatsAppInteractiveMessage,
      });
    } else if (resume.checkoutPendingAction === 'payment_method') {
      resumeFollowUps.push({
        type: 'interactive',
        message: buildPaymentButtonsMessage(resume.text),
      });
    }
    return {
      ...baseResult,
      followUps: [...(baseResult.followUps ?? []), ...resumeFollowUps],
    };
  }

  if (signals.handback) {
    await clearCheckoutSession(conversationId);
    console.log(
      JSON.stringify({
        event: '[checkout-agent] handback_to_main',
        reason: signals.handbackReason,
        conversationId,
      })
    );

    const userMessage = handbackState?.webhookContext?.message?.text?.body?.trim() ?? '';
    const detectionContext = handbackState?.detectionContext;
    let hybridResult: HandlerResult | null = null;
    if (detectionContext && userMessage) {
      hybridResult = await invokeHybridAfterCheckoutHandback({
        enrichedCtx,
        conversationId,
        detectionContext,
        userMessage,
      });
      if (hybridResult) {
        console.log(
          JSON.stringify({
            event: '[checkout-agent] handback_inline_hybrid',
            conversationId,
          })
        );
      }
    }

    return (
      hybridResult ?? {
        content: safeText,
        isInteractive: false,
        skipBodyHumanization: true,
      }
    );
  }

  if (signals.paymentMethod === 'cash') {
    const result = await payCashHandler.execute(enrichedCtx);
    await clearCheckoutSession(conversationId);
    if (result) {
      return result;
    }
  }

  if (signals.paymentMethod === 'online') {
    const result = await payOnlineHandler.execute(enrichedCtx);
    await clearCheckoutSession(conversationId);
    if (result) {
      return result;
    }
  }

  // Un solo mensaje interactivo (texto del LLM como body + botones), en vez de
  // un mensaje de texto y un followUp aparte repitiendo la misma pregunta
  // (visto en pruebas manuales contra el bot real: la Tarea 4.1 corrige esto).
  if (signals.presentFulfillmentOptions) {
    await patchConversationMetadata(conversationId, {
      checkout_pending_action: 'fulfillment_type',
      checkout_pending_question: FULFILLMENT_TYPE_SHORT_QUESTION,
    });
    return {
      content: buildFulfillmentSelectionMessage(safeText),
      isInteractive: true,
      skipBodyHumanization: true,
    };
  }

  if (signals.presentPaymentOptions) {
    await patchConversationMetadata(conversationId, {
      checkout_pending_action: 'payment_method',
      checkout_pending_question: PAYMENT_METHOD_SHORT_QUESTION,
    });
    return {
      content: buildPaymentButtonsMessage(safeText),
      isInteractive: true,
      skipBodyHumanization: true,
    };
  }

  return { content: safeText, isInteractive: false, skipBodyHumanization: true };
};

// ---------------------------------------------------------------------------
// Nodo principal
// ---------------------------------------------------------------------------

const payCashHandler = new PayCashHandler();
const payOnlineHandler = new PayOnlineHandler();

export const checkoutAgentNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const ctx = state.webhookContext!;
  const enrichedBase = state.enrichedCtx as unknown as EnrichedContext;
  const conversation = state.conversation!;
  const business = state.business!;
  const customer = state.customer!;
  const businessConfig = state.businessConfig;
  const payloadId = ctx.payloadId;
  const conversationId = conversation.id;
  const phone = customer.phone_number ?? ctx.to;

  const deliveryEnabled = businessConfig?.delivery_enabled ?? true;
  const takeawayEnabled = businessConfig?.takeaway_enabled ?? false;

  if (payloadId === 'PAY_CASH') {
    const result = await payCashHandler.execute(enrichedBase as EnrichedContext);
    await clearCheckoutSession(conversationId);
    return {
      handlerResult: result ?? undefined,
      dataCollectionDelegated: true,
    };
  }

  if (payloadId === 'PAY_ONLINE') {
    const result = await payOnlineHandler.execute(enrichedBase as EnrichedContext);
    await clearCheckoutSession(conversationId);
    return {
      handlerResult: result ?? undefined,
      dataCollectionDelegated: true,
    };
  }

  if (payloadId === 'CANCEL_CHECKOUT') {
    await clearCheckoutSession(conversationId);
    return {
      handlerResult:
        textResponse(
          '🤖\n\n*Checkout cancelado* 👋\n\nTu pedido sigue guardado en el carrito. Avisame cuando quieras retomarlo.'
        ) ?? undefined,
      dataCollectionDelegated: true,
    };
  }

  if (payloadId === 'FULFILLMENT_DELIVERY') {
    await setDraftFulfillmentType(business.id, phone, 'DELIVERY');
    await omitConversationMetadataKeys(conversationId, [
      'checkout_pending_action',
      'checkout_pending_question',
    ]);
  } else if (payloadId === 'FULFILLMENT_TAKE_AWAY') {
    await setDraftFulfillmentType(business.id, phone, 'TAKE_AWAY');
    await omitConversationMetadataKeys(conversationId, [
      'checkout_pending_action',
      'checkout_pending_question',
    ]);
  }

  if (payloadId === 'CHECKOUT') {
    const emptyCart = await activateCheckoutSessionIfCartHasItems({
      businessId: business.id,
      phone,
      conversationId,
    });
    if (emptyCart) {
      return { handlerResult: emptyCart, dataCollectionDelegated: true };
    }
  }

  // ── Mensaje tipo `location` — procesado determinístico (H-08) ────────────
  // El agente de checkout pide la dirección de entrega y el cliente responde
  // con la forma más natural de compartirla en WhatsApp: la ubicación. Se
  // guarda directo (no vía staging de onboarding_step, que secuestraría el
  // routing del turno siguiente hacia onboarding_by_state — ver
  // `resolveAndSaveFromLocation`).
  if (ctx.message?.type === 'location' && ctx.message.location) {
    const { lat, lng } = ctx.message.location as { lat: number; lng: number };
    const result = await new AddressService().resolveAndSaveFromLocation({
      businessId: business.id,
      customerId: customer.id,
      lat,
      lng,
    });
    if (result.status === 'out_of_coverage') {
      return {
        handlerResult: textResponse(ADDRESS_OUT_OF_COVERAGE_BOT_MESSAGE) ?? undefined,
        dataCollectionDelegated: true,
      };
    }
    return {
      handlerResult:
        textResponse(
          `📍 Guardé tu dirección: ${result.formattedAddress}\n\nSeguimos con tu pedido.`
        ) ?? undefined,
      dataCollectionDelegated: true,
    };
  }

  const checkoutCtx: CheckoutAgentContext = {
    hasAddress: state.hasAddress,
    isInCoverage: state.isInCoverage,
    deliveryEnabled,
    takeawayEnabled,
  };

  await applyDefaultFulfillmentIfSingleOption({
    businessId: business.id,
    phone,
    deliveryEnabled,
    takeawayEnabled,
  });

  // Payload interactivo huérfano (H-09): un botón/lista de un CTA viejo que
  // este nodo no maneja explícitamente (ni PAY_*/CANCEL_CHECKOUT/FULFILLMENT_*/
  // CHECKOUT). Sin esto, el agente recibía el turno con `userMsg=''` y
  // respondía a ciegas, perdiendo la acción que el cliente tocó.
  const KNOWN_CHECKOUT_PAYLOADS = new Set(['FULFILLMENT_DELIVERY', 'FULFILLMENT_TAKE_AWAY', 'CHECKOUT']);
  const agentCtx =
    payloadId && !KNOWN_CHECKOUT_PAYLOADS.has(payloadId)
      ? withOrphanPayloadAsText(enrichedBase)
      : enrichedBase;

  const handlerResult = await resolveCheckoutAgentHandlerResult({
    enrichedCtx: agentCtx,
    checkoutCtx,
    conversationId,
    handbackState: state,
  });

  return {
    handlerResult,
    dataCollectionDelegated: true,
  };
};
