import type {
  WhatsAppInteractiveMessage,
  WhatsAppListMessage,
} from '../../domain/intent/whatsappTemplates';
import type { IntentDetectionResult } from '../ai/detection.service';
import type { ConversationIntent } from '../../types/conversationIntent';

/**
 * Entrada base del Ledger de la familia Intent (ADR-0007).
 * Extensiones tipadas por IntentType viven en `intentLedger` abajo.
 */
export type IntentLedgerEntryBase = {
  /** El cliente pidió explícitamente que no insistamos (solo Goals). */
  abandonment?: boolean;
  /** Veces que se planteó el Intent esta "vida". */
  surfaceCount?: number;
  /** ISO timestamp del último planteo (cooldown). */
  lastSurfacedAt?: string | null;
  /** Alerts de cierre por emisión. */
  emitted?: boolean;
  /** Nacimiento del Intent (decay / TTL). */
  openedAt?: string | null;
  /** Expiración explícita (ISO); si falta, se deriva de openedAt + catálogo. */
  expiresAt?: string | null;
};

export type ConversationMetadata = {
  pendingProductSelection?: boolean;
  pendingQuestion?: string;
  candidateProductIds?: string[];
  /**
   * Confirmación pendiente sobre un ítem del carrito (`cart.service.ts`).
   * `CONFIRM_REMOVE` es el Constraint de borde de `remove_cart_item`
   * (ADR-0002): fuente única, compartida entre el flujo determinístico de
   * botones y la Tool del agente híbrido — evita que ambos mantengan su
   * propia copia de "qué ítem está pendiente de confirmación".
   */
  pendingAction?: 'CONFIRM_REMOVE' | 'EDIT_CART';
  pendingItemId?: string;
  pendingItemName?: string;
  /** ISO timestamp de cuándo se planteó `pendingAction`, para el TTL de confirmación. */
  pendingActionAt?: string;
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
  /**
   * `true` mientras una dirección compartida al híbrido (pregunta de envío
   * delegada) espera confirmación — ver `AddressService.stageAddressForDelegatedConfirmation`
   * y `delegatedAddressConfirmationNode`. `context/index.ts` prioriza este
   * flag sobre cualquier otra sesión activa.
   */
  pending_address_confirmation?: boolean;
  pending_address_text?: string | null;
  pending_address_lat?: number | null;
  pending_address_lng?: number | null;
  pending_address_zone_id?: string | null;
  /** Intent de carrito que quedó pendiente mientras el usuario elige delivery vs take-away. */
  pending_fulfillment_action?: string | null;
  /** Payload ADD_ITEM pendiente de confirmación cuando el negocio está cerrado con orders_when_closed=true. */
  pending_closed_add_item?: string | null;
  /**
   * Timestamp ISO de cuando el cliente aceptó pedir fuera de horario. Dura
   * toda la conversación (D5 de PLAN-ACCION-CALIDAD-CONVERSACIONAL.md): una
   * vez confirmado, los ADD_ITEM siguientes de la misma conversación no
   * vuelven a pedir esta confirmación. Se limpia solo al resetear el estado
   * de la conversación por inactividad (conversación nueva → confirmación nueva).
   */
  closed_order_confirmed_at?: string | null;
  /**
   * `true` mientras el cliente está en una sesión activa del agente de checkout.
   * Se activa al tocar el botón CHECKOUT (con CHECKOUT_AGENT_ENABLED=true) y se
   * limpia al finalizar el pago, cancelar, hacer handback o expirar el draft.
   */
  checkout_active?: boolean;

  /**
   * @deprecated Fase B.1 — vive en `intentLedger.OBTENER_NOMBRE.refusalCount`.
   * Se limpia al leer/escribir vía `intentRefusal.service`.
   */
  name_refusal_count?: number;

  /**
   * @deprecated Fase B.1 — vive en `intentLedger.OBTENER_DIRECCION.refusalCount`.
   * Se limpia al leer/escribir vía `intentRefusal.service`.
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
   * Forma base reutilizable; campos específicos por IntentType se agregan
   * como extensión tipada, no como bag libre.
   */
  intentLedger?: {
    COMPLETAR_PEDIDO?: IntentLedgerEntryBase;
    COMPLETAR_RESERVA?: IntentLedgerEntryBase;
    OBTENER_NOMBRE?: IntentLedgerEntryBase & { refusalCount?: number };
    OBTENER_DIRECCION?: IntentLedgerEntryBase & { refusalCount?: number };
    CONFIRMAR_OFERTA?: IntentLedgerEntryBase & {
      productId?: string;
      productName?: string;
      suggestedQuantity?: number;
      source?: string;
    };
    SUGERIR_COMPLEMENTO?: IntentLedgerEntryBase;
    SUGERIR_DIRECCION?: IntentLedgerEntryBase;
    OFRECER_PROMOCION?: IntentLedgerEntryBase;
    RECOLECTAR_PARTY_SIZE?: IntentLedgerEntryBase;
    PEDIDO_POR_EXPIRAR?: IntentLedgerEntryBase & { emitted?: boolean };
    NEGOCIO_POR_CERRAR?: IntentLedgerEntryBase & { emitted?: boolean };
    FUERA_DE_COBERTURA?: IntentLedgerEntryBase & { emitted?: boolean };
    ITEM_SIN_STOCK?: IntentLedgerEntryBase & { emitted?: boolean };
    PAGO_RECHAZADO?: IntentLedgerEntryBase & { emitted?: boolean };
    RESERVA_PROXIMA?: IntentLedgerEntryBase & { emitted?: boolean };
    CONFIRMAR_PAGO_ONLINE?: IntentLedgerEntryBase;
    DESBLOQUEAR_PEDIDO_CERRADO?: IntentLedgerEntryBase;
    RETOMAR_TAREA_INTERRUMPIDA?: IntentLedgerEntryBase;
    RESPONDER_CONSULTA_PENDIENTE?: IntentLedgerEntryBase;
    DESAMBIGUAR_PRODUCTO?: IntentLedgerEntryBase;
    CONFIRMAR_ELIMINACION?: IntentLedgerEntryBase;
  };

  /**
   * Referencia TEMPORAL de un código de Embajador de Domingo Sabrosón
   * (`DS_REF=AMB-...`) validado en esta conversación. Vive solo mientras no
   * exista un pedido: `createOrderFromDraft` la copia a `orders.ambassador_public_code`
   * y borra esta clave (nunca queda asociada permanentemente al chat, así
   * compras futuras del mismo cliente no comisionan automáticamente).
   * Expira sola tras `AMBASSADOR_REF_TTL_MS` (ver ambassador/referralCode.ts).
   */
  ambassador_ref?: {
    code: string;
    validatedAt: string;
  } | null;
};

export type ConversationMode = 'GLOBAL' | 'FILTER_SET' | 'PRODUCT_FOCUS';

export type ProductQueryServiceResult =
  | string
  | WhatsAppListMessage
  | WhatsAppInteractiveMessage
  | null;
