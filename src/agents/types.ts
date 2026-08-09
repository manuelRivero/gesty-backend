/**
 * Tipos del contrato de CTA híbrido.
 *
 * Flujo actual:
 *  agente ReAct llama `present_product_cta` (opcional)
 *  → ctaResolver valida/resuelve productIds
 *  → buildHybridCtaInteractive
 *
 * `CtaPlannerRaw` se reutiliza como forma intermedia del payload de la tool
 * (el LLM planner post-proceso ya no es dueño del turno).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Acción resuelta (post-resolver, productId verificado contra BD)
// ---------------------------------------------------------------------------

export type CtaAction =
  | { kind: 'ADD_ITEM'; productId: string; quantity: number; label: string }
  | { kind: 'VIEW_MENU'; label: string }
  | { kind: 'VIEW_FEATURED'; label: string }
  | {
      kind: 'SELECT_FROM_LIST';
      candidates: Array<{ productId: string; title: string; description?: string }>;
      bodyText: string;
    };

/** Acciones sin lista (aptas para botón secundario). */
export type CtaActionSimple = Extract<CtaAction, { kind: 'VIEW_MENU' | 'VIEW_FEATURED' }>;

/** Plan de CTA resuelto, listo para pasar al builder. */
export interface CtaPlan {
  /** Hint de nombre de producto que originó el plan (para logging). */
  productHint?: string;
  primary: CtaAction;
  secondary?: CtaActionSimple;
}

// ---------------------------------------------------------------------------
// Salida cruda del planner LLM (antes de resolver productId)
// ---------------------------------------------------------------------------

/** Schema Zod para validar la salida JSON del planner LLM. */
export const CtaPlannerRawSchema = z.object({
  shouldShowCta: z.boolean(),
  /** Nombre del producto mencionado en la respuesta del bot (sin UUID). */
  productHint: z.string().nullable(),
  /**
   * Nombres de los productos mencionados en la respuesta del bot cuando son ≥2.
   * Sólo aplica para `primaryKind = 'SELECT_FROM_LIST'`. Ignorado en los demás casos.
   * Entre 2 y 5 nombres recomendado.
   */
  productHints: z.array(z.string()).nullable().optional(),
  primaryKind: z.enum(['ADD_ITEM', 'VIEW_MENU', 'VIEW_FEATURED', 'SELECT_FROM_LIST']),
  /** Etiqueta del botón primario — máximo 20 caracteres. */
  primaryLabel: z.string(),
  secondaryKind: z.enum(['VIEW_MENU', 'VIEW_FEATURED']).nullable(),
  /** Etiqueta del botón secundario — máximo 20 caracteres. */
  secondaryLabel: z.string().nullable(),
});

export type CtaPlannerRaw = z.infer<typeof CtaPlannerRawSchema>;

// ---------------------------------------------------------------------------
// Parámetros de entrada para el planner y el resolver
// ---------------------------------------------------------------------------

export interface CtaPlannerInput {
  /** Texto completo que el bot va a enviar. */
  botResponseText: string;
  /** Intent detectado (e.g. PRODUCT_ATTRIBUTE_QUESTION). */
  intent: string;
  /** Nombre de producto detectado por la capa NLP. */
  detectedProductName: string | null;
  /** Nombre del último producto referenciado en la conversación (de metadata). */
  lastReferencedProductName: string | null;
  /** Mensaje textual que escribió el usuario. */
  userMessage: string;
  /** Nombres de los N productos más relevantes encontrados en el menú (pre-fetch). */
  topMenuProductNames: string[];
  /**
   * Nombres de los productos que el agente YA resolvió como shortlist en esta
   * misma respuesta (tools `search_products` / `find_products_by_filter`).
   * Señal autoritativa para el planner: ≥2 ⇒ SELECT_FROM_LIST con estos nombres;
   * exactamente 1 ⇒ ADD_ITEM. Vacío cuando el agente no listó productos.
   */
  listedProductNames: string[];
}

export interface CtaResolverInput {
  plannerRaw: CtaPlannerRaw;
  businessId: string;
  /** UUID del último producto referenciado en la conversación. */
  lastReferencedProductId: string | null;
  /** Nombre detectado por la capa NLP (fallback si planner no dio hint). */
  detectedProductName: string | null;
  /** Texto de la respuesta del bot (para verificar nombres). */
  botResponseText: string;
  /** Cantidad del intent detectado (Fase 2: support quantity > 1). */
  detectionQuantity: number | null;
  /** Mensaje del usuario (para señales léxicas de compra). */
  userMessage: string;
}
