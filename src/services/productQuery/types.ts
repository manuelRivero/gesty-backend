import type {
  WhatsAppInteractiveMessage,
  WhatsAppListMessage,
} from '../../domain/intent/whatsappTemplates';
import type { IntentDetectionResult } from '../ai/detection.service';
import type { ConversationIntent } from '../../types/conversationIntent';

export type ConversationMetadata = {
  pendingProductSelection?: boolean;
  pendingQuestion?: string;
  candidateProductIds?: string[];
  /**
   * Personas/comensales de contexto de sesión (persiste durante el pedido).
   * Reemplaza el uso temporal de solo product query.
   */
  requestedPartySize?: number;
  /** Alias explícito de personas (mismo valor que requestedPartySize cuando aplica). */
  peopleCount?: number;
  /** @deprecated Lectura legacy; preferir requestedPartySize. */
  pendingProductQueryQuantity?: number;
  /**
   * Última cantidad sugerida al elegir desde lista (recomendador); respaldo si el botón es ADD_ITEM sin :N.
   */
  lastListSuggestedQuantity?: number;
  /** Suma de quantity × serves_people (fallback 1) en el borrador activo; sincronizado al mutar carrito. */
  coveredPortions?: number;
  /** peopleCount − coveredPortions (mínimo 0); solo si hay N personas en contexto. */
  missingPortions?: number;
  /**
   * Banners de flujo post-principales ya mostrados (evita repetir).
   * @see nextActionAfterMains.ts
   */
  nextActionHintsShown?: Partial<
    Record<'DRINK' | 'STARTER' | 'DESSERT' | 'CHECKOUT', boolean>
  >;
  /** Esperando respuesta numérica de personas antes de recomendaciones/pedido. */
  awaitingPeopleCount?: boolean;
  /** El clasificador dudó entre intenciones; el usuario debe elegir un botón CONFIRM_INTENT. */
  awaitingIntentConfirmation?: boolean;
  /** Los dos candidatos principales mostrados al usuario (misma forma que en detection). */
  intentCandidates?: Array<{ intent: ConversationIntent; confidence: number }>;
  /** Snapshot para reanudar ORDER_FOOD / PRODUCT_QUERY tras responder cuántas personas. */
  peopleCountResume?: {
    userMessage: string;
    detection: IntentDetectionResult;
  };
};

export type ConversationMode = 'GLOBAL' | 'FILTER_SET' | 'PRODUCT_FOCUS';

export type ProductQueryServiceResult =
  | string
  | WhatsAppListMessage
  | WhatsAppInteractiveMessage
  | null;
