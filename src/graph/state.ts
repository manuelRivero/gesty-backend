/**
 * Estado del `StateGraph` principal del agente WhatsApp.
 *
 * Replica los campos que en el orquestador imperativo
 * [src/controllers/webhook/orchestrator.ts] viven como variables locales en
 * `processWebhook` (`ctx`, `business`, `businessConfig`, `conversation`,
 * `conversationState`, `detection`, `result`, etc.) más algunos flags de
 * control que LangGraph necesita para enrutar entre nodos (`earlyExit`,
 * `shouldSkipSend`, `routeAfterContext`, `routeAfterDetection`).
 *
 * El reducer por defecto de `Annotation` es "last value wins" — cada nodo
 * devuelve un parche parcial del estado.
 */

import { Annotation } from '@langchain/langgraph';
import type { business, customer, conversation, conversation_state } from '@prisma/client';
import type {
  EnrichedContext,
  HandlerResult,
  WebhookContext,
  WhatsAppWebhookPayload,
} from '../controllers/webhook/types';
import type {
  DetectionContext,
  IntentDetectionResult,
} from '../services/ai/detection.service';
import type { getBusinessOpenInfo } from '../services/businessHours.service';
import type { BusinessConfig } from '../services/businessConfig.service';
import type { ConversationIntent } from '../types/conversationIntent';

export type BusinessOpenInfo = Awaited<ReturnType<typeof getBusinessOpenInfo>>;

export type EarlyExitReason =
  | 'invalid_payload'
  | 'status_only_event'
  | 'business_not_found'
  | 'business_closed'
  | 'persist_failed'
  | 'subscription_blocked'
  | 'unsupported_message_type'
  | 'bot_disabled_or_human_handled'
  | 'reservation_handled'
  | 'onboarding_handled'
  | 'address_capture_handled'
  | 'interactive_no_payload'
  | 'awaiting_people_count_invalid'
  | 'asked_intent_confirmation'
  | 'asked_people_count'
  | 'no_handler_match';

/**
 * Decisión de routing tras los gates de contexto. La consume el conditional
 * edge entre `buildDetectionContextNode` y los subflujos especiales / NLP.
 */
export type ContextRoute =
  | 'reservation_wizard'
  | 'onboarding_by_state'
  | 'address_capture'
  | 'interactive'
  | 'nlp';

/** Decisión de routing tras NLP / payload mapping. */
export type IntentRoute =
  | 'send_only'
  | 'handler'
  | 'asked_confirmation'
  | 'asked_people_count'
  | 'end';

export const AgentStateAnnotation = Annotation.Root({
  // ─── Entrada cruda (extractor) ────────────────────────────────────────────
  webhookPayload: Annotation<WhatsAppWebhookPayload | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  webhookContext: Annotation<WebhookContext | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // ─── Contexto resuelto ────────────────────────────────────────────────────
  business: Annotation<business | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  businessConfig: Annotation<BusinessConfig | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  customer: Annotation<customer | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  conversation: Annotation<conversation | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  conversationState: Annotation<conversation_state | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  workingConversationState: Annotation<conversation_state | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  recentMessages: Annotation<Array<{ id?: string; message: string }>>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  businessStatus: Annotation<BusinessOpenInfo | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * `true` cuando el negocio está cerrado pero `operate_when_closed` está habilitado
   * en la config. El bot sigue operando pero puede restringir acciones de carrito.
   */
  businessClosedButOperating: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  hasAddress: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  isInCoverage: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),

  // ─── NLP ──────────────────────────────────────────────────────────────────
  detectionContext: Annotation<DetectionContext | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  detection: Annotation<IntentDetectionResult | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  userMessage: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),

  // Contexto enriquecido completo que recibe handlers (mismo shape que hoy)
  enrichedCtx: Annotation<EnrichedContext | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // ─── Salida ───────────────────────────────────────────────────────────────
  handlerResult: Annotation<HandlerResult | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  conversationId: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // ─── Control de flujo ─────────────────────────────────────────────────────
  earlyExit: Annotation<EarlyExitReason | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  contextRoute: Annotation<ContextRoute | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  intentRoute: Annotation<IntentRoute | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /** Intención final ya enrutada; usada por el conditional edge `routeByIntent`. */
  resolvedIntent: Annotation<ConversationIntent | string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /** Si `true`, no se ejecuta `persistAIMessageNode` tras enviar (paridad con el aviso de negocio cerrado). */
  skipAIPersistence: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),

  /**
   * Si `true`, la conversación acaba de ser derivada a un agente humano
   * (intent SUPPORT). Los nodos `addressCollection` y `nameCollection` deben
   * omitirse porque no tiene sentido pedirle datos al usuario cuando el bot ya
   * se despidió y cedió el control.
   */
  isHumanHandover: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),

  /**
   * Si `true`, el gate `fulfillmentSelection` reemplazó el `handlerResult`
   * con el mensaje de selección "Delivery / Retiro en local". El routing
   * saltea `addressCollection` y `nameCollection` y va directo a `SEND`.
   */
  fulfillmentSelectionPending: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),

  /**
   * `true` cuando el turno fue procesado por el ReAct agent (modo híbrido).
   * Los post-gates conversacionales (`fulfillmentSelection`, `addressCollection`,
   * `nameCollection`) se saltan porque el agente gestiona la recolección de datos
   * de forma natural a través de contexto inyectado + tools de escritura.
   */
  dataCollectionDelegated: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),

  /**
   * Ruta de delegación del wizard de reservas cuando el usuario se va off-topic
   * y la reserva queda pausada. Encadena `interactive` o `nlp` en el mismo invoke.
   */
  reservationDelegateRoute: Annotation<'nlp' | 'interactive' | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * `true` cuando el wizard reanudó una reserva pausada en este invoke.
   */
  reservationResumed: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;
export type AgentStateUpdate = Partial<AgentState>;
