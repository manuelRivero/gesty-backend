/**
 * `StateGraph` principal del agente WhatsApp.
 *
 * Reproduce el flujo imperativo de
 * [src/controllers/webhook/orchestrator.ts] del backend original:
 *
 * extract → resolveBusiness → businessConfig → resolveCustomer →
 * businessOpenInfo (→ closedBusiness → send) → normalizeOwnerAudio (→ end si
 * wamid duplicado) → persistUserMessage →
 * subscriptionAccessGate (→ send) → messageTypeGuard (→ send) →
 * escalationGate (→ send) →
 * ambassadorReferral →
 * buildDetectionContext →
 * { ownerAssistant | reservationWizard | reservationAgent | onboardingAgent | checkoutAgent | interactive | nlp } →
 * sendResponse → persistAIMessage → END.
 *
 * `normalizeOwnerAudio` (PLAN-ACCION-OWNER-AUDIO.md): si el remitente es el
 * dueño autorizado y el mensaje es audio, descarga + transcribe y muta
 * `webhookContext.message` a texto antes de persistir — el resto del grafo
 * no distingue audio de texto del dueño. No-op para cualquier otro caso.
 *
 * `messageTypeGuard` filtra mensajes no procesables (imágenes, audio, video,
 * contactos, documentos, ubicación fuera de un flujo de captura de dirección,
 * etc.) y responde con un aviso amable + reply button "Pedir ayuda".
 *
 * `escalationGate` (V-02, ADR-0002) es un interrupt determinista: corre en
 * todo turno, antes de que Ownership decida quién habla, sin excepción de
 * sesión. Si el cliente pidió un humano (texto libre o botón "Pedir ayuda"),
 * corta acá — nunca llega a checkout/reserva/onboarding/NLP.
 */

import { END, START, StateGraph } from '@langchain/langgraph';
import { AgentStateAnnotation } from './state';
import {
  extractContextNode,
  resolveBusinessNode,
  resolveBusinessConfigNode,
  resolveCustomerNode,
  businessOpenInfoNode,
  persistUserMessageNode,
  buildDetectionContextNode,
} from './nodes/context';
import {
  closedBusinessNode,
  subscriptionAccessGateNode,
  reservationWizardNode,
} from './nodes/gates';
import { fulfillmentSelectionNode } from './nodes/gates/fulfillmentSelection';
import { messageTypeGuardNode } from './nodes/gates/messageTypeGuard';
import { escalationGateNode } from './nodes/gates/escalation';
import { ambassadorReferralNode } from './nodes/ambassador';
import { normalizeOwnerAudioNode } from './nodes/ownerAudio';
import {
  interactiveSubgraphNode,
  nlpSubgraphNode,
} from './nodes/dispatch';
import { checkoutAgentNode } from './nodes/checkout';
import { paymentProofNode } from './nodes/paymentProof';
import { delegatedAddressConfirmationNode } from './nodes/session/delegatedAddressConfirmation';
import { reservationAgentNode } from './nodes/reservation';
import { onboardingAgentNode } from './nodes/onboarding';
import { ownerAssistantAgentNode } from './nodes/ownerAssistant';
import { sendResponseNode, persistAIMessageNode } from './nodes/send';
import {
  NODE,
  routeAfterBusinessOpen,
  routeAfterDetectionContext,
  routeAfterExtract,
  routeAfterHandlerOrSubflow,
  routeAfterFulfillmentSelection,
  routeAfterEscalationGate,
  routeAfterMessageTypeGuard,
  routeAfterOwnerAudio,
  routeAfterPersistUser,
  routeAfterResolveBusiness,
  routeAfterReservation,
  routeAfterSend,
  routeAfterSubscriptionGate,
} from './routers';

const builder = new StateGraph(AgentStateAnnotation)
  .addNode(NODE.EXTRACT, extractContextNode)
  .addNode(NODE.RESOLVE_BIZ, resolveBusinessNode)
  .addNode(NODE.RESOLVE_BIZ_CONFIG, resolveBusinessConfigNode)
  .addNode(NODE.RESOLVE_CUSTOMER, resolveCustomerNode)
  .addNode(NODE.BIZ_OPEN, businessOpenInfoNode)
  .addNode(NODE.CLOSED_BIZ, closedBusinessNode)
  .addNode(NODE.OWNER_AUDIO, normalizeOwnerAudioNode)
  .addNode(NODE.PERSIST_USER, persistUserMessageNode)
  .addNode(NODE.SUBSCRIPTION_GATE, subscriptionAccessGateNode)
  .addNode(NODE.MESSAGE_TYPE_GUARD, messageTypeGuardNode)
  .addNode(NODE.ESCALATION_GATE, escalationGateNode)
  .addNode(NODE.AMBASSADOR_REFERRAL, ambassadorReferralNode)
  .addNode(NODE.BUILD_DETECTION_CTX, buildDetectionContextNode)
  // @deprecated NODE.RESERVATION = wizard legacy. Ver reservationWizardNode.
  .addNode(NODE.RESERVATION, reservationWizardNode)
  .addNode(NODE.ONBOARDING_AGENT, onboardingAgentNode)
  .addNode(NODE.DELEGATED_ADDRESS_CONFIRMATION, delegatedAddressConfirmationNode)
  .addNode(NODE.INTERACTIVE, interactiveSubgraphNode)
  .addNode(NODE.NLP, nlpSubgraphNode)
  .addNode(NODE.CHECKOUT_AGENT, checkoutAgentNode)
  .addNode(NODE.PAYMENT_PROOF, paymentProofNode)
  .addNode(NODE.RESERVATION_AGENT, reservationAgentNode)
  .addNode(NODE.OWNER_ASSISTANT, ownerAssistantAgentNode)
  .addNode(NODE.FULFILLMENT_SELECTION, fulfillmentSelectionNode)
  .addNode(NODE.SEND, sendResponseNode)
  .addNode(NODE.PERSIST_AI, persistAIMessageNode);

builder.addEdge(START, NODE.EXTRACT);

builder.addConditionalEdges(NODE.EXTRACT, routeAfterExtract, {
  [NODE.RESOLVE_BIZ]: NODE.RESOLVE_BIZ,
  [END]: END,
});

builder.addConditionalEdges(NODE.RESOLVE_BIZ, routeAfterResolveBusiness, {
  [NODE.RESOLVE_BIZ_CONFIG]: NODE.RESOLVE_BIZ_CONFIG,
  [END]: END,
});

builder.addEdge(NODE.RESOLVE_BIZ_CONFIG, NODE.RESOLVE_CUSTOMER);
builder.addEdge(NODE.RESOLVE_CUSTOMER, NODE.BIZ_OPEN);

builder.addConditionalEdges(NODE.BIZ_OPEN, routeAfterBusinessOpen, {
  [NODE.CLOSED_BIZ]: NODE.CLOSED_BIZ,
  [NODE.OWNER_AUDIO]: NODE.OWNER_AUDIO,
  [END]: END,
});

builder.addConditionalEdges(NODE.CLOSED_BIZ, routeAfterHandlerOrSubflow, {
  [NODE.FULFILLMENT_SELECTION]: NODE.FULFILLMENT_SELECTION,
  [NODE.SEND]: NODE.SEND,
  [END]: END,
});

builder.addConditionalEdges(NODE.OWNER_AUDIO, routeAfterOwnerAudio, {
  [NODE.PERSIST_USER]: NODE.PERSIST_USER,
  [END]: END,
});

builder.addConditionalEdges(NODE.PERSIST_USER, routeAfterPersistUser, {
  [NODE.SUBSCRIPTION_GATE]: NODE.SUBSCRIPTION_GATE,
  [END]: END,
});

builder.addConditionalEdges(NODE.SUBSCRIPTION_GATE, routeAfterSubscriptionGate, {
  [NODE.SEND]: NODE.SEND,
  [NODE.MESSAGE_TYPE_GUARD]: NODE.MESSAGE_TYPE_GUARD,
  [END]: END,
});

builder.addConditionalEdges(NODE.MESSAGE_TYPE_GUARD, routeAfterMessageTypeGuard, {
  [NODE.SEND]: NODE.SEND,
  [NODE.ESCALATION_GATE]: NODE.ESCALATION_GATE,
  [END]: END,
});

builder.addConditionalEdges(NODE.ESCALATION_GATE, routeAfterEscalationGate, {
  [NODE.SEND]: NODE.SEND,
  [NODE.AMBASSADOR_REFERRAL]: NODE.AMBASSADOR_REFERRAL,
  [END]: END,
});

builder.addEdge(NODE.AMBASSADOR_REFERRAL, NODE.BUILD_DETECTION_CTX);

builder.addConditionalEdges(
  NODE.BUILD_DETECTION_CTX,
  routeAfterDetectionContext,
  {
    [NODE.RESERVATION]: NODE.RESERVATION,
    [NODE.RESERVATION_AGENT]: NODE.RESERVATION_AGENT,
    [NODE.ONBOARDING_AGENT]: NODE.ONBOARDING_AGENT,
    [NODE.DELEGATED_ADDRESS_CONFIRMATION]: NODE.DELEGATED_ADDRESS_CONFIRMATION,
    [NODE.CHECKOUT_AGENT]: NODE.CHECKOUT_AGENT,
    [NODE.PAYMENT_PROOF]: NODE.PAYMENT_PROOF,
    [NODE.OWNER_ASSISTANT]: NODE.OWNER_ASSISTANT,
    [NODE.INTERACTIVE]: NODE.INTERACTIVE,
    [NODE.NLP]: NODE.NLP,
    [END]: END,
  }
);

for (const node of [
  NODE.ONBOARDING_AGENT,
  NODE.DELEGATED_ADDRESS_CONFIRMATION,
  NODE.INTERACTIVE,
  NODE.NLP,
  NODE.CHECKOUT_AGENT,
  NODE.PAYMENT_PROOF,
  NODE.RESERVATION_AGENT,
  NODE.OWNER_ASSISTANT,
] as const) {
  builder.addConditionalEdges(node, routeAfterHandlerOrSubflow, {
    [NODE.FULFILLMENT_SELECTION]: NODE.FULFILLMENT_SELECTION,
    [NODE.SEND]: NODE.SEND,
    [END]: END,
  });
}

builder.addConditionalEdges(NODE.RESERVATION, routeAfterReservation, {
  [NODE.INTERACTIVE]: NODE.INTERACTIVE,
  [NODE.NLP]: NODE.NLP,
  [NODE.FULFILLMENT_SELECTION]: NODE.FULFILLMENT_SELECTION,
  [NODE.SEND]: NODE.SEND,
  [END]: END,
});

builder.addConditionalEdges(NODE.FULFILLMENT_SELECTION, routeAfterFulfillmentSelection, {
  [NODE.SEND]: NODE.SEND,
  [END]: END,
});

builder.addConditionalEdges(NODE.SEND, routeAfterSend, {
  [NODE.PERSIST_AI]: NODE.PERSIST_AI,
  [END]: END,
});

builder.addEdge(NODE.PERSIST_AI, END);

export const mainGraph = builder.compile();

export type MainGraph = typeof mainGraph;
