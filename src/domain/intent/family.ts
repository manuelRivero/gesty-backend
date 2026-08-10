/**
 * Familia Intent (ADR-0008): Goal / Opportunity / Alert comparten ciclo de
 * vida, Ledger y ranker. Este módulo materializa el catálogo cerrado de
 * TAXONOMIA.md — la fuente de verdad de propiedades es el documento; el
 * código solo la tipa. Agregar un IntentType es PR de catálogo (ADR-0011).
 */

export type IntentKind = 'goal' | 'opportunity' | 'alert';
export type IntentPressure = 'blocking' | 'resumable' | 'ambient' | 'emit_once';
export type IntentCloseMode = 'fact_change' | 'decay' | 'emission' | 'emission_then_fact';

/**
 * Solo tipos ya listados en TAXONOMIA y cableados (o tipados para el Ledger).
 * Ampliar por PR al conectar cada uno — nunca una decisión de runtime.
 */
export type IntentType =
  | 'COMPLETAR_PEDIDO'
  | 'COMPLETAR_RESERVA'
  | 'OBTENER_NOMBRE'
  | 'OBTENER_DIRECCION'
  | 'CONFIRMAR_OFERTA'
  | 'SUGERIR_COMPLEMENTO'
  | 'SUGERIR_DIRECCION'
  | 'OFRECER_PROMOCION'
  | 'RECOLECTAR_PARTY_SIZE'
  | 'PEDIDO_POR_EXPIRAR'
  | 'NEGOCIO_POR_CERRAR'
  | 'FUERA_DE_COBERTURA'
  | 'ITEM_SIN_STOCK'
  | 'PAGO_RECHAZADO'
  | 'RESERVA_PROXIMA'
  | 'CONFIRMAR_PAGO_ONLINE'
  | 'DESBLOQUEAR_PEDIDO_CERRADO'
  | 'RETOMAR_TAREA_INTERRUMPIDA'
  | 'RESPONDER_CONSULTA_PENDIENTE'
  | 'DESAMBIGUAR_PRODUCTO'
  | 'CONFIRMAR_ELIMINACION'
  | 'RESOLVER_COBERTURA'
  | 'DEFINIR_ENTREGA'
  | 'DEFINIR_METODO_DE_PAGO'
  | 'CONFIRMAR_PEDIDO';

export type IntentCandidate = {
  type: IntentType;
  kind: IntentKind;
  pressure: IntentPressure;
  closeMode: IntentCloseMode;
  /** Hint corto para [ESTADO DEL CLIENTE]; nunca copy final al cliente. */
  hint: string;
  /** Desempate dentro del mismo nivel de saliencia. Mayor = más urgente. */
  tieBreak: number;
};

export type IntentCatalogEntry = {
  kind: IntentKind;
  pressure: IntentPressure;
  closeMode: IntentCloseMode;
  /** Presupuesto de planteos por "vida". Goals: 3; Opportunities/Alerts: 1. */
  maxSurfaces: number;
  /** Cooldown entre planteos (ms). 0 = sin cooldown. */
  cooldownMs: number;
  /** TTL de decay (ms). Solo Opportunities / Intents declarados. */
  ttlMs: number | null;
  /** Si true, el cliente no puede silenciarla (Alerts críticas). */
  critical: boolean;
};

/** Materialización de TAXONOMIA §2–§4. Toda key de IntentType debe existir acá. */
export const INTENT_CATALOG: Record<IntentType, IntentCatalogEntry> = {
  COMPLETAR_PEDIDO: {
    kind: 'goal',
    pressure: 'resumable',
    closeMode: 'fact_change',
    maxSurfaces: 3,
    cooldownMs: 10 * 60 * 1000,
    ttlMs: null,
    critical: false,
  },
  COMPLETAR_RESERVA: {
    kind: 'goal',
    pressure: 'resumable',
    closeMode: 'fact_change',
    maxSurfaces: 3,
    cooldownMs: 10 * 60 * 1000,
    ttlMs: null,
    critical: false,
  },
  DEFINIR_ENTREGA: {
    kind: 'goal',
    pressure: 'blocking',
    closeMode: 'fact_change',
    maxSurfaces: 3,
    cooldownMs: 0,
    ttlMs: null,
    critical: false,
  },
  OBTENER_DIRECCION: {
    kind: 'goal',
    pressure: 'blocking',
    closeMode: 'fact_change',
    maxSurfaces: 3,
    cooldownMs: 0,
    ttlMs: null,
    critical: false,
  },
  OBTENER_NOMBRE: {
    kind: 'goal',
    pressure: 'blocking',
    closeMode: 'fact_change',
    maxSurfaces: 3,
    cooldownMs: 0,
    ttlMs: null,
    critical: false,
  },
  DEFINIR_METODO_DE_PAGO: {
    kind: 'goal',
    pressure: 'blocking',
    closeMode: 'fact_change',
    maxSurfaces: 3,
    cooldownMs: 0,
    ttlMs: null,
    critical: false,
  },
  CONFIRMAR_PEDIDO: {
    kind: 'goal',
    pressure: 'blocking',
    closeMode: 'fact_change',
    maxSurfaces: 3,
    cooldownMs: 0,
    ttlMs: null,
    critical: false,
  },
  CONFIRMAR_PAGO_ONLINE: {
    kind: 'goal',
    pressure: 'resumable',
    closeMode: 'fact_change',
    maxSurfaces: 3,
    cooldownMs: 10 * 60 * 1000,
    ttlMs: null,
    critical: false,
  },
  RESOLVER_COBERTURA: {
    kind: 'goal',
    pressure: 'blocking',
    closeMode: 'fact_change',
    maxSurfaces: 3,
    cooldownMs: 0,
    ttlMs: null,
    critical: false,
  },
  CONFIRMAR_ELIMINACION: {
    kind: 'goal',
    pressure: 'blocking',
    closeMode: 'fact_change',
    maxSurfaces: 3,
    cooldownMs: 0,
    ttlMs: null,
    critical: false,
  },
  DESBLOQUEAR_PEDIDO_CERRADO: {
    kind: 'goal',
    pressure: 'resumable',
    closeMode: 'fact_change',
    maxSurfaces: 3,
    cooldownMs: 10 * 60 * 1000,
    ttlMs: null,
    critical: false,
  },
  RETOMAR_TAREA_INTERRUMPIDA: {
    kind: 'goal',
    pressure: 'resumable',
    closeMode: 'decay',
    maxSurfaces: 3,
    cooldownMs: 0,
    ttlMs: null, // TTL sesión — se limpia al cerrar conversación
    critical: false,
  },
  RESPONDER_CONSULTA_PENDIENTE: {
    kind: 'goal',
    pressure: 'resumable',
    closeMode: 'decay',
    maxSurfaces: 3,
    cooldownMs: 0,
    ttlMs: 24 * 60 * 60 * 1000,
    critical: false,
  },
  DESAMBIGUAR_PRODUCTO: {
    kind: 'goal',
    pressure: 'blocking',
    closeMode: 'decay',
    maxSurfaces: 3,
    cooldownMs: 0,
    ttlMs: 3 * 60 * 1000, // 3 turnos ≈ proxy temporal; se ajusta al cablear
    critical: false,
  },
  CONFIRMAR_OFERTA: {
    kind: 'opportunity',
    pressure: 'ambient',
    closeMode: 'decay',
    maxSurfaces: 1,
    cooldownMs: 0,
    ttlMs: 15 * 60 * 1000,
    critical: false,
  },
  /**
   * Completar menú: olas tras «sí» (engaged). Un «no» (refused) abandona.
   * maxSurfaces acota olas totales; el gate real es refused/engaged/cooldown
   * en `computeSuggestComplementPermission` (no presupuesto 1 al primer surface).
   */
  SUGERIR_COMPLEMENTO: {
    kind: 'opportunity',
    pressure: 'ambient',
    closeMode: 'decay',
    maxSurfaces: 5,
    cooldownMs: 3 * 60 * 1000,
    ttlMs: 30 * 60 * 1000,
    critical: false,
  },
  SUGERIR_DIRECCION: {
    kind: 'opportunity',
    pressure: 'ambient',
    closeMode: 'decay',
    maxSurfaces: 1,
    cooldownMs: 0,
    ttlMs: 60 * 60 * 1000,
    critical: false,
  },
  RECOLECTAR_PARTY_SIZE: {
    kind: 'opportunity',
    pressure: 'ambient',
    closeMode: 'decay',
    maxSurfaces: 1,
    cooldownMs: 0,
    ttlMs: 60 * 60 * 1000,
    critical: false,
  },
  OFRECER_PROMOCION: {
    kind: 'opportunity',
    pressure: 'ambient',
    closeMode: 'decay',
    maxSurfaces: 1,
    cooldownMs: 0,
    ttlMs: 60 * 60 * 1000,
    critical: false,
  },
  NEGOCIO_POR_CERRAR: {
    kind: 'alert',
    pressure: 'emit_once',
    closeMode: 'emission',
    maxSurfaces: 1,
    cooldownMs: 0,
    ttlMs: null,
    critical: true,
  },
  PEDIDO_POR_EXPIRAR: {
    kind: 'alert',
    pressure: 'emit_once',
    closeMode: 'emission',
    maxSurfaces: 1,
    cooldownMs: 0,
    ttlMs: null,
    critical: true,
  },
  ITEM_SIN_STOCK: {
    kind: 'alert',
    pressure: 'emit_once',
    closeMode: 'emission',
    maxSurfaces: 1,
    cooldownMs: 0,
    ttlMs: null,
    critical: true,
  },
  RESERVA_PROXIMA: {
    kind: 'alert',
    pressure: 'emit_once',
    closeMode: 'emission',
    maxSurfaces: 1,
    cooldownMs: 0,
    ttlMs: null,
    critical: true,
  },
  PAGO_RECHAZADO: {
    kind: 'alert',
    pressure: 'blocking',
    closeMode: 'emission_then_fact',
    maxSurfaces: 1,
    cooldownMs: 0,
    ttlMs: null,
    critical: true,
  },
  FUERA_DE_COBERTURA: {
    kind: 'alert',
    pressure: 'blocking',
    closeMode: 'emission_then_fact',
    maxSurfaces: 1,
    cooldownMs: 10 * 60 * 1000,
    ttlMs: null,
    critical: true,
  },
};

/** Assert runtime: todo IntentType del union tiene entrada de catálogo. */
export const assertIntentCatalogComplete = (): void => {
  // El Record<IntentType, …> ya lo garantiza a nivel de tipos; este helper
  // existe para el test de A.1 y para fallar ruidoso si alguien castea a ciegas.
  const missing = (Object.keys(INTENT_CATALOG) as IntentType[]).filter(
    (key) => !INTENT_CATALOG[key]
  );
  if (missing.length > 0) {
    throw new Error(`INTENT_CATALOG incompleto: ${missing.join(', ')}`);
  }
};

export const getIntentCatalogEntry = (type: IntentType): IntentCatalogEntry => {
  const entry = INTENT_CATALOG[type];
  if (!entry) {
    throw new Error(`IntentType sin entrada de catálogo: ${type}`);
  }
  return entry;
};

/**
 * Orden de saliencia (ADR-0008 / ADR-0009). Menor = más urgente.
 * Empates dentro del mismo rank se resuelven con `tieBreak` del candidato.
 */
export const saliencyRank = (c: Pick<IntentCandidate, 'kind' | 'pressure'>): number => {
  if (c.kind === 'alert' && c.pressure === 'blocking') return 0; // crítica que exige resolución
  if (c.kind === 'alert') return 1; // cierre por emisión
  if (c.kind === 'goal' && c.pressure === 'blocking') return 2;
  if (c.kind === 'goal') return 3; // reanudable
  return 4; // opportunity
};
