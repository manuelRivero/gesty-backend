/**
 * `StateGraph` principal del agente WhatsApp.
 *
 * Reproduce el flujo imperativo de
 * [src/controllers/webhook/orchestrator.ts] del backend original:
 *
 * extract → resolveBusiness → businessConfig → resolveCustomer →
 * businessOpenInfo (→ closedBusiness → send) → persistUserMessage →
 * subscriptionAccessGate (→ send) → messageTypeGuard (→ send) →
 * buildDetectionContext →
 * { reservationWizard | onboardingByState | addressCapture | interactive | nlp } →
 * sendResponse → persistAIMessage → END.
 *
 * `messageTypeGuard` filtra mensajes no procesables (imágenes, audio, video,
 * contactos, documentos, ubicación fuera de un flujo de captura de dirección,
 * etc.) y responde con un aviso amable + reply button "Pedir ayuda".
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
  onboardingByStateNode,
  addressCaptureNode,
} from './nodes/gates';
import { addressCollectionNode } from './nodes/gates/addressCollection';
import { fulfillmentSelectionNode } from './nodes/gates/fulfillmentSelection';
import { nameCollectionNode } from './nodes/gates/nameCollection';
import { messageTypeGuardNode } from './nodes/gates/messageTypeGuard';
import {
  interactiveSubgraphNode,
  nlpSubgraphNode,
} from './nodes/dispatch';
import { checkoutAgentNode } from './nodes/checkout';
import { reservationAgentNode } from './nodes/reservation';
import { sendResponseNode, persistAIMessageNode } from './nodes/send';
import {
  NODE,
  routeAfterBusinessOpen,
  routeAfterDetectionContext,
  routeAfterExtract,
  routeAfterHandlerOrSubflow,
  routeAfterFulfillmentSelection,
  routeAfterAddressCollection,
  routeAfterMessageTypeGuard,
  routeAfterNameCollection,
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
  .addNode(NODE.PERSIST_USER, persistUserMessageNode)
  .addNode(NODE.SUBSCRIPTION_GATE, subscriptionAccessGateNode)
  .addNode(NODE.MESSAGE_TYPE_GUARD, messageTypeGuardNode)
  .addNode(NODE.BUILD_DETECTION_CTX, buildDetectionContextNode)
  .addNode(NODE.RESERVATION, reservationWizardNode)
  .addNode(NODE.ONBOARDING_BY_STATE, onboardingByStateNode)
  .addNode(NODE.ADDRESS_CAPTURE, addressCaptureNode)
  .addNode(NODE.INTERACTIVE, interactiveSubgraphNode)
  .addNode(NODE.NLP, nlpSubgraphNode)
  .addNode(NODE.CHECKOUT_AGENT, checkoutAgentNode)
  .addNode(NODE.RESERVATION_AGENT, reservationAgentNode)
  .addNode(NODE.FULFILLMENT_SELECTION, fulfillmentSelectionNode)
  .addNode(NODE.ADDRESS_COLLECTION, addressCollectionNode)
  .addNode(NODE.NAME_COLLECTION, nameCollectionNode)
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
  [NODE.PERSIST_USER]: NODE.PERSIST_USER,
  [END]: END,
});

builder.addConditionalEdges(NODE.CLOSED_BIZ, routeAfterHandlerOrSubflow, {
  [NODE.FULFILLMENT_SELECTION]: NODE.FULFILLMENT_SELECTION,
  [NODE.SEND]: NODE.SEND,
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
  [NODE.BUILD_DETECTION_CTX]: NODE.BUILD_DETECTION_CTX,
  [END]: END,
});

builder.addConditionalEdges(
  NODE.BUILD_DETECTION_CTX,
  routeAfterDetectionContext,
  {
    [NODE.RESERVATION]: NODE.RESERVATION,
    [NODE.RESERVATION_AGENT]: NODE.RESERVATION_AGENT,
    [NODE.ONBOARDING_BY_STATE]: NODE.ONBOARDING_BY_STATE,
    [NODE.ADDRESS_CAPTURE]: NODE.ADDRESS_CAPTURE,
    [NODE.CHECKOUT_AGENT]: NODE.CHECKOUT_AGENT,
    [NODE.INTERACTIVE]: NODE.INTERACTIVE,
    [NODE.NLP]: NODE.NLP,
    [END]: END,
  }
);

for (const node of [
  NODE.ONBOARDING_BY_STATE,
  NODE.ADDRESS_CAPTURE,
  NODE.INTERACTIVE,
  NODE.NLP,
  NODE.CHECKOUT_AGENT,
  NODE.RESERVATION_AGENT,
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
  [NODE.ADDRESS_COLLECTION]: NODE.ADDRESS_COLLECTION,
  [END]: END,
});

builder.addConditionalEdges(NODE.ADDRESS_COLLECTION, routeAfterAddressCollection, {
  [NODE.NAME_COLLECTION]: NODE.NAME_COLLECTION,
  [END]: END,
});

builder.addConditionalEdges(NODE.NAME_COLLECTION, routeAfterNameCollection, {
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
