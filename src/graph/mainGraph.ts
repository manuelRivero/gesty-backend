/**
 * `StateGraph` principal del agente WhatsApp.
 *
 * Reproduce el flujo imperativo de
 * [src/controllers/webhook/orchestrator.ts] del backend original:
 *
 * extract → resolveBusiness → businessConfig → resolveCustomer →
 * businessOpenInfo (→ closedBusiness → send) → persistUserMessage →
 * subscriptionAccessGate (→ send) → buildDetectionContext →
 * { reservationWizard | onboardingByState | addressCapture | interactive | nlp } →
 * sendResponse → persistAIMessage → END.
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
import {
  interactiveSubgraphNode,
  nlpSubgraphNode,
} from './nodes/dispatch';
import { sendResponseNode, persistAIMessageNode } from './nodes/send';
import {
  NODE,
  routeAfterBusinessOpen,
  routeAfterDetectionContext,
  routeAfterExtract,
  routeAfterHandlerOrSubflow,
  routeAfterPersistUser,
  routeAfterResolveBusiness,
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
  .addNode(NODE.BUILD_DETECTION_CTX, buildDetectionContextNode)
  .addNode(NODE.RESERVATION, reservationWizardNode)
  .addNode(NODE.ONBOARDING_BY_STATE, onboardingByStateNode)
  .addNode(NODE.ADDRESS_CAPTURE, addressCaptureNode)
  .addNode(NODE.INTERACTIVE, interactiveSubgraphNode)
  .addNode(NODE.NLP, nlpSubgraphNode)
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
  [NODE.SEND]: NODE.SEND,
  [END]: END,
});

builder.addConditionalEdges(NODE.PERSIST_USER, routeAfterPersistUser, {
  [NODE.SUBSCRIPTION_GATE]: NODE.SUBSCRIPTION_GATE,
  [END]: END,
});

builder.addConditionalEdges(NODE.SUBSCRIPTION_GATE, routeAfterSubscriptionGate, {
  [NODE.SEND]: NODE.SEND,
  [NODE.BUILD_DETECTION_CTX]: NODE.BUILD_DETECTION_CTX,
  [END]: END,
});

builder.addConditionalEdges(
  NODE.BUILD_DETECTION_CTX,
  routeAfterDetectionContext,
  {
    [NODE.RESERVATION]: NODE.RESERVATION,
    [NODE.ONBOARDING_BY_STATE]: NODE.ONBOARDING_BY_STATE,
    [NODE.ADDRESS_CAPTURE]: NODE.ADDRESS_CAPTURE,
    [NODE.INTERACTIVE]: NODE.INTERACTIVE,
    [NODE.NLP]: NODE.NLP,
    [END]: END,
  }
);

for (const node of [
  NODE.RESERVATION,
  NODE.ONBOARDING_BY_STATE,
  NODE.ADDRESS_CAPTURE,
  NODE.INTERACTIVE,
  NODE.NLP,
] as const) {
  builder.addConditionalEdges(node, routeAfterHandlerOrSubflow, {
    [NODE.SEND]: NODE.SEND,
    [END]: END,
  });
}

builder.addConditionalEdges(NODE.SEND, routeAfterSend, {
  [NODE.PERSIST_AI]: NODE.PERSIST_AI,
  [END]: END,
});

builder.addEdge(NODE.PERSIST_AI, END);

export const mainGraph = builder.compile();

export type MainGraph = typeof mainGraph;
