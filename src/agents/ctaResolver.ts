/**
 * CTA Resolver — capa determinística que convierte la salida cruda del planner
 * en un `CtaPlan` con `productId` verificado contra la BD.
 *
 * Orden de prioridad para resolver ADD_ITEM:
 *  1. Buscar por productHint del planner via MenuService.searchMenuItemsByKeyword.
 *  2. Buscar por detectedProductName (fallback si planner no dio hint).
 *  3. Usar lastReferencedProductId directamente (trusted source).
 *  4. Degrade a SELECT_FROM_LIST si hay 2-5 candidatos.
 *  5. Degrade a VIEW_MENU si nada resuelve.
 *
 * Para SELECT_FROM_LIST recibido del planner (multi-producto): se busca cada
 * nombre de `productHints` por separado y se arman los candidates con la mejor
 * coincidencia de cada uno; si no se resuelven ≥2 productos, fallback a
 * VIEW_FEATURED.
 *
 * Fase 2: señales léxicas ("uno", "ese", "ese mismo") con lastReferencedProductId.
 */

import { MenuService, type MenuItemSearchResult } from '../services/menu.service';
import { prisma } from '../lib/prisma';
import type { CtaPlannerRaw, CtaPlan, CtaAction, CtaActionSimple, CtaResolverInput } from './types';

// ---------------------------------------------------------------------------
// Helpers de normalización
// ---------------------------------------------------------------------------

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Verifica que el texto del bot menciona palabras del nombre del producto.
 * Leniente: basta con que alguna palabra significativa (>3 chars) aparezca.
 */
const productMentionedInText = (productName: string, text: string): boolean => {
  const normName = normalize(productName);
  const normText = normalize(text);
  const words = normName.split(' ').filter((w) => w.length > 3);
  if (words.length === 0) return normText.includes(normName);
  return words.some((w) => normText.includes(w));
};

/**
 * Detecta señales léxicas de intención de compra en el mensaje del usuario.
 * Útil para resolver "uno" / "ese" / "ese mismo" → lastReferencedProductId.
 */
const LEXICAL_BUY_SIGNALS =
  /\b(quiero|dame|agrega|sum[aá]me|lléva(me)?|pedir|para\s+llevar|comprar|un[oa]|ese|esa|ese\s+mismo)\b/i;

export const hasLexicalBuySignal = (userMessage: string): boolean =>
  LEXICAL_BUY_SIGNALS.test(normalize(userMessage));

/** Trunca etiquetas de botón a 20 caracteres (límite WhatsApp). */
const truncateLabel = (label: string): string => label.slice(0, 20);

// ---------------------------------------------------------------------------
// Acciones predefinidas
// ---------------------------------------------------------------------------

const viewMenuAction = (label = 'Ver menú'): CtaActionSimple => ({
  kind: 'VIEW_MENU',
  label: truncateLabel(label),
});

const viewFeaturedAction = (label = 'Ver destacados'): CtaActionSimple => ({
  kind: 'VIEW_FEATURED',
  label: truncateLabel(label),
});

// ---------------------------------------------------------------------------
// Resolución principal
// ---------------------------------------------------------------------------

const buildSelectFromList = (
  candidates: MenuItemSearchResult[],
  bodyText: string,
  secondaryLabel: string | null
): CtaPlan => ({
  primary: {
    kind: 'SELECT_FROM_LIST',
    candidates: candidates.slice(0, 5).map((c) => ({
      productId: c.id,
      title: c.name,
      description: c.description ?? c.ingredients ?? undefined,
    })),
    bodyText,
  },
  secondary: secondaryLabel ? viewMenuAction(secondaryLabel) : viewMenuAction(),
});

const buildAddItem = (
  productId: string,
  quantity: number,
  primaryLabel: string,
  secondaryRaw: CtaPlannerRaw['secondaryKind'],
  secondaryLabel: string | null,
  productHint?: string
): CtaPlan => {
  const secondary: CtaActionSimple =
    secondaryRaw === 'VIEW_FEATURED'
      ? viewFeaturedAction(secondaryLabel ?? undefined)
      : viewMenuAction(secondaryLabel ?? undefined);

  return {
    productHint,
    primary: {
      kind: 'ADD_ITEM',
      productId,
      quantity,
      label: truncateLabel(primaryLabel),
    },
    secondary,
  };
};

/**
 * Busca productos por keyword y decide qué acción devolver.
 * Devuelve `null` si no se pudo resolver (el caller debe hacer fallback).
 */
const resolveByKeyword = async (params: {
  keyword: string;
  businessId: string;
  botResponseText: string;
  quantity: number;
  plannerRaw: CtaPlannerRaw;
}): Promise<CtaPlan | null> => {
  const { keyword, businessId, botResponseText, quantity, plannerRaw } = params;
  let results: MenuItemSearchResult[];
  try {
    results = await MenuService.searchMenuItemsByKeyword({ businessId, keyword });
  } catch (err) {
    console.error('[hybrid-cta] searchMenuItemsByKeyword failed:', err);
    return null;
  }

  if (results.length === 0) return null;

  if (results.length === 1) {
    const product = results[0];
    // Soft verification: the bot mentioned the product (or we trust a single unambiguous result)
    const verified = productMentionedInText(product.name, botResponseText) || results.length === 1;
    if (verified) {
      return buildAddItem(
        product.id,
        quantity,
        plannerRaw.primaryLabel,
        plannerRaw.secondaryKind,
        plannerRaw.secondaryLabel,
        keyword
      );
    }
    return null;
  }

  // 2–5 candidates → list for user to pick
  if (results.length <= 5) {
    return buildSelectFromList(results, botResponseText, plannerRaw.secondaryLabel);
  }

  // >5 → too ambiguous, return top 5 as list
  return buildSelectFromList(results.slice(0, 5), botResponseText, plannerRaw.secondaryLabel);
};

/**
 * Resuelve un `SELECT_FROM_LIST` declarado por el planner: busca cada nombre
 * de `productHints` por separado y arma los candidates con la mejor coincidencia
 * de cada uno. Devuelve `null` si no se logran resolver al menos 2 productos
 * (el caller cae a VIEW_FEATURED).
 */
const resolveSelectFromList = async (params: {
  productHints: string[];
  businessId: string;
  botResponseText: string;
  plannerRaw: CtaPlannerRaw;
}): Promise<CtaPlan | null> => {
  const { productHints, businessId, botResponseText, plannerRaw } = params;

  const seenIds = new Set<string>();
  const matched: MenuItemSearchResult[] = [];

  for (const hint of productHints) {
    if (!hint || !hint.trim()) continue;
    let results: MenuItemSearchResult[];
    try {
      results = await MenuService.searchMenuItemsByKeyword({
        businessId,
        keyword: hint,
      });
    } catch (err) {
      console.error('[hybrid-cta] searchMenuItemsByKeyword failed (multi):', err);
      continue;
    }
    const best = results.find((r) => !seenIds.has(r.id));
    if (best) {
      seenIds.add(best.id);
      matched.push(best);
    }
    if (matched.length >= 5) break;
  }

  if (matched.length < 2) return null;

  return buildSelectFromList(matched, botResponseText, plannerRaw.secondaryLabel);
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Toma el plan crudo del planner y lo convierte en un `CtaPlan` con
 * `productId` verificado. Nunca lanza excepción: en caso de error devuelve
 * un plan de VIEW_MENU como fallback seguro.
 */
export const resolveCta = async (input: CtaResolverInput): Promise<CtaPlan> => {
  const {
    plannerRaw,
    businessId,
    lastReferencedProductId,
    detectedProductName,
    botResponseText,
    detectionQuantity,
    userMessage,
  } = input;

  const quantity = Math.min(99, Math.max(1, detectionQuantity ?? 1));

  try {
    // Acciones no-transaccionales: resolve directo
    if (plannerRaw.primaryKind === 'VIEW_MENU') {
      return {
        primary: viewMenuAction(plannerRaw.primaryLabel),
        secondary: plannerRaw.secondaryKind === 'VIEW_FEATURED'
          ? viewFeaturedAction(plannerRaw.secondaryLabel ?? undefined)
          : undefined,
      };
    }

    if (plannerRaw.primaryKind === 'VIEW_FEATURED') {
      return {
        primary: viewFeaturedAction(plannerRaw.primaryLabel),
        secondary: plannerRaw.secondaryKind === 'VIEW_MENU'
          ? viewMenuAction(plannerRaw.secondaryLabel ?? undefined)
          : undefined,
      };
    }

    // primaryKind === 'SELECT_FROM_LIST': resolver cada productHint por separado
    if (plannerRaw.primaryKind === 'SELECT_FROM_LIST') {
      const hints = (plannerRaw.productHints ?? []).filter(
        (h) => typeof h === 'string' && h.trim().length > 0
      );

      if (hints.length >= 2) {
        const resolved = await resolveSelectFromList({
          productHints: hints,
          businessId,
          botResponseText,
          plannerRaw,
        });
        if (resolved) return resolved;
      }

      // Fallback: si el planner pidió SELECT_FROM_LIST pero no logramos resolver
      // ≥2 productos, mostramos destacados (mejor que un menú genérico).
      return {
        primary: viewFeaturedAction(plannerRaw.primaryLabel || 'Ver destacados'),
        secondary: viewMenuAction(plannerRaw.secondaryLabel ?? undefined),
      };
    }

    // primaryKind === 'ADD_ITEM': necesitamos resolver productId

    // Fase 2: señal léxica fuerte ("quiero uno", "ese mismo") + lastReferencedProductId
    if (
      lastReferencedProductId &&
      hasLexicalBuySignal(userMessage) &&
      !plannerRaw.productHint
    ) {
      return buildAddItem(
        lastReferencedProductId,
        quantity,
        plannerRaw.primaryLabel,
        plannerRaw.secondaryKind,
        plannerRaw.secondaryLabel
      );
    }

    // Paso 1: buscar por productHint del planner (mejor señal: el planner leyó el texto del bot)
    if (plannerRaw.productHint && plannerRaw.productHint.trim()) {
      const resolved = await resolveByKeyword({
        keyword: plannerRaw.productHint,
        businessId,
        botResponseText,
        quantity,
        plannerRaw,
      });
      if (resolved) return resolved;
    }

    // Paso 2: buscar por detectedProductName del NLP (segunda señal más confiable)
    if (detectedProductName && detectedProductName !== plannerRaw.productHint) {
      const resolved = await resolveByKeyword({
        keyword: detectedProductName,
        businessId,
        botResponseText,
        quantity,
        plannerRaw,
      });
      if (resolved) return resolved;
    }

    // Paso 3: usar lastReferencedProductId directamente (trusted from prev interaction)
    if (lastReferencedProductId) {
      try {
        const product = await prisma.menu_item.findUnique({
          where: { id: lastReferencedProductId },
          select: { id: true, name: true },
        });
        if (product) {
          return buildAddItem(
            product.id,
            quantity,
            plannerRaw.primaryLabel,
            plannerRaw.secondaryKind,
            plannerRaw.secondaryLabel,
            product.name
          );
        }
      } catch (err) {
        console.error('[hybrid-cta] lastReferencedProductId lookup failed:', err);
      }
    }

    // Fallback final: VIEW_MENU
    return {
      primary: viewMenuAction(),
      secondary: viewFeaturedAction(),
    };
  } catch (err) {
    console.error('[hybrid-cta] resolveCta unexpected error:', err);
    return { primary: viewMenuAction() };
  }
};
