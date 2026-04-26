/**
 * Tipos del contrato de salida del sistema CTA híbrido.
 *
 * Flujo:
 *  runHybridReactAgent → texto ReAct
 *  → ctaPlanner (LLM, CtaPlannerRaw)
 *  → ctaResolver (determinístico, CtaPlan resuelto)
 *  → buildHybridCtaInteractive (HandlerResult interactivo)
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
  primaryKind: z.enum(['ADD_ITEM', 'VIEW_MENU', 'VIEW_FEATURED']),
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
