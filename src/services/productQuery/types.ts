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

  // --- CTA híbrido ---

  /**
   * ISO timestamp de la última vez que se mostró un CTA híbrido.
   * Usado para cooldown de 1 turno (5 min window).
   */
  lastCtaShownAt?: string | null;
  /** ID del producto principal del último CTA mostrado (para correlacionar follow-through). */
  lastCtaProductId?: string | null;
  /** Payload exacto del botón primario del último CTA (para correlacionar clicks). */
  lastCtaPayload?: string | null;

  // --- Detección / contexto de sesión ---

  /** Último nombre de producto referenciado (para planner y contexto de detección). */
  lastReferencedProductName?: string | null;

  // --- Wizards ---

  /** Paso activo del wizard de reservas. Presente solo mientras el wizard está activo. */
  reservation?: { step?: string; paused?: boolean; [key: string]: unknown };
  /** Paso activo del wizard de onboarding. Presente solo mientras el wizard está activo. */
  onboarding_step?: string;
  /** Dirección temporal capturada durante onboarding (antes de confirmar). */
  temp_address?: Record<string, unknown>;
  /** `true` mientras esperamos que el cliente nos diga su nombre. */
  awaiting_name?: boolean;
  /** `true` mientras esperamos que el cliente nos diga su dirección de entrega. */
  awaiting_address?: boolean;
  /** Intent original que fue bloqueado por falta de dirección (ej. CHECKOUT); se usa para retomar al confirmar. */
  pending_address_action?: string | null;
  /** Intent de carrito que quedó pendiente mientras el usuario elige delivery vs take-away. */
  pending_fulfillment_action?: string | null;
  /** Payload ADD_ITEM pendiente de confirmación cuando el negocio está cerrado con orders_when_closed=true. */
  pending_closed_add_item?: string | null;
  /**
   * `true` mientras el cliente está en una sesión activa del agente de checkout.
   * Se activa al tocar el botón CHECKOUT (con CHECKOUT_AGENT_ENABLED=true) y se
   * limpia al finalizar el pago, cancelar, hacer handback o expirar el draft.
   */
  checkout_active?: boolean;

  /**
   * `true` mientras el cliente tiene una sesión activa del agente de reservas.
   * Se activa cuando el intent RESERVATION se detecta (con RESERVATION_AGENT_ENABLED=true)
   * y se limpia al confirmar, cancelar o al llamar abandon_reservation.
   */
  reservation_agent_active?: boolean;

  /**
   * Borrador de los datos recolectados por el agente de reservas durante la
   * sesión activa. Se persiste turno a turno via tools de escritura.
   */
  reservation_draft?: {
    /** Fecha elegida en formato DD/MM/AAAA ya resuelta. */
    date?: string;
    /** ID del slot elegido (reservation_slot.id). */
    slotId?: string;
    /** Hora de inicio en HH:MM. */
    time?: string;
    /** Hora de fin en HH:MM. */
    endTime?: string;
    /** Cantidad de personas. */
    partySize?: number;
    /** ID del ambiente elegido; null = sin preferencia. */
    environmentId?: string | null;
  };
};

export type ConversationMode = 'GLOBAL' | 'FILTER_SET' | 'PRODUCT_FOCUS';

export type ProductQueryServiceResult =
  | string
  | WhatsAppListMessage
  | WhatsAppInteractiveMessage
  | null;
