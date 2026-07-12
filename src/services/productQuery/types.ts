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
  /**
   * Modo híbrido: el agente pidió party size y hay una consulta de menú
   * congelada en `peopleCountResume` para reanudar al responder.
   */
  awaitingPartySize?: boolean;
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

  /**
   * Oferta conversacional activa para el hybrid agent (confirmación en texto libre).
   * @see lastOffer.service.ts
   */
  lastOffer?: {
    kind: 'ADD_ITEM';
    productId: string;
    productName: string;
    suggestedQuantity: number;
    offeredAt: string;
    source: 'hybrid_cta' | 'product_query' | 'product_focus' | 'product_attribute';
  } | null;

  // --- Detección / contexto de sesión ---

  /** Último nombre de producto referenciado (para planner y contexto de detección). */
  lastReferencedProductName?: string | null;

  // --- Wizards ---

  /**
   * @deprecated Paso activo del wizard LEGACY de reservas (reemplazado por
   * `reservation_draft` + `reservation_agent_active`). Presente solo en
   * sesiones iniciadas antes del agente, o si `RESERVATION_AGENT_ENABLED`
   * está apagado. Ver `reservation.service.ts`.
   */
  reservation?: { step?: string; paused?: boolean; [key: string]: unknown };
  /** Paso activo del wizard de onboarding. Presente solo mientras el wizard está activo. */
  onboarding_step?: string;
  /** `true` mientras el cliente está en una sesión activa del agente de onboarding. */
  onboarding_agent_active?: boolean;
  /** Dirección temporal capturada durante onboarding (antes de confirmar). */
  temp_address?: string | Record<string, unknown>;
  /** `true` mientras esperamos que el cliente nos diga su nombre. */
  awaiting_name?: boolean;
  /**
   * `true` mientras esperamos que el cliente nos diga su dirección de entrega
   * y el próximo mensaje de texto debe CAPTURARSE como tal (rutea a
   * onboarding/`address_capture`). Distinto de `address_soft_asked` (H-06):
   * este flag SÍ debe setearse solo en el camino bloqueante (intent de
   * carrito/pedido sin dirección), nunca en la sugerencia informativa.
   */
  awaiting_address?: boolean;
  /**
   * Timestamp ISO de la última sugerencia NO bloqueante de cargar dirección
   * (`ADDRESS_SOFT_ASK_BOT_MESSAGE`). Puramente informativo: a diferencia de
   * `awaiting_address`, nunca debe usarse para rutear un turno. Existe solo
   * para no repetir la sugerencia en cada mensaje; expira sola (ver
   * `ADDRESS_SOFT_ASK_TTL_MS` en `addressCollection.ts`).
   */
  address_soft_asked?: string | null;
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
   * Cantidad de veces que el cliente rechazó explícitamente dar su nombre
   * durante la sesión de checkout activa. Se resetea al limpiar la sesión.
   */
  name_refusal_count?: number;

  /**
   * Cantidad de veces que el cliente rechazó dar su dirección de entrega
   * (rechazo explícito o dirección no encontrada repetidamente) durante
   * la sesión de checkout activa. Se resetea al limpiar la sesión.
   */
  address_refusal_count?: number;

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

  /**
   * Ledger de la familia Intent (ADR-0007): memoria del comportamiento del
   * sistema sobre cada Goal/Opportunity/Alert, indexada por tipo. Nunca
   * datos del negocio — si se borra entero, solo cambia el tono del bot.
   */
  intentLedger?: {
    COMPLETAR_PEDIDO?: {
      /** El cliente pidió explícitamente que no insistamos (ADR-0005). */
      abandonment?: boolean;
      /** Veces que se planteó el Goal esta "vida" del pedido (ADR-0008: 3 → enmudece). */
      surfaceCount?: number;
      /** ISO timestamp del último planteo, para el cooldown. */
      lastSurfacedAt?: string | null;
    };
    COMPLETAR_RESERVA?: {
      /** El cliente pidió explícitamente que no insistamos con la reserva (ADR-0005). */
      abandonment?: boolean;
      /** Veces que se planteó el Goal esta "vida" del borrador (ADR-0008: 3 → enmudece). */
      surfaceCount?: number;
      /** ISO timestamp del último planteo, para el cooldown. */
      lastSurfacedAt?: string | null;
    };
  };
};

export type ConversationMode = 'GLOBAL' | 'FILTER_SET' | 'PRODUCT_FOCUS';

export type ProductQueryServiceResult =
  | string
  | WhatsAppListMessage
  | WhatsAppInteractiveMessage
  | null;
