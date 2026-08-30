/**
 * OFRECER_PROMOCION — Fact + Opportunity (TAXONOMIA §3, ADR-0008/0009).
 *
 * Dos canales, igual que `lastOffer.service.ts` (el precedente que este módulo
 * instancia deliberadamente):
 *
 * - **Fact** (`buildPromotionFactLines`): la verdad del carrito ahora mismo.
 *   Una promo ya aplicada es dinero que el cliente TIENE derecho a conocer:
 *   se comunica siempre, no gasta presupuesto y sobrevive a `refused`,
 *   `budget_exhausted` y al TTL.
 * - **Opportunity** (`derivePromotionCandidate`): permiso de PLANTEAR que
 *   agregando algo se desbloquea un beneficio. Eso sí compite en el ranker y
 *   gasta `surfaceCount`.
 *
 * FACT ≠ OPPORTUNITY: si se mezclaran, una promo aplicada dejaría de
 * comunicarse cuando se agota el presupuesto de planteo — exactamente el bug
 * que documentó y corrigió PLAN-FIX-LAST-OFFER-LIFECYCLE.md para lastOffer.
 */

import type { MenuCategoryTag } from '@prisma/client';
import { getIntentCatalogEntry, type IntentCandidate } from '../../domain/intent/family';
import { computeCatalogPermission, type IntentLedgerEntry } from './activeIntent.service';
import { patchIntentLedgerEntry } from '../intentLedger.repository';
import { normalizeMetadata } from '../productQuery/utils';
import type { PromotionEvaluation } from '../promotions/promotionEvaluation.types';

export const PROMOTION_INTENT_TYPE = 'OFRECER_PROMOCION' as const;

/**
 * D14 — Umbral de relevancia. Una promo desbloqueable por un ahorro
 * insignificante no merece gastar la única intervención del turno, aunque su
 * descuento se aplique igual si el cliente llega a cumplirla.
 *
 * PROVISIONAL: valor absoluto fijo a la espera de datos de producción
 * (ver §9 del plan). El gate vive en el DERIVADOR, no en el ranker: así el
 * ranker sigue sin saber qué es una promoción y el orden sigue siendo estático
 * y auditable (D7).
 */
export const PROMOTION_MIN_RELEVANT_SAVING = 500;

export const hasAppliedPromotions = (evaluation: PromotionEvaluation): boolean =>
  evaluation.applied.length > 0;

/**
 * Mejor promoción desbloqueable que supera el umbral de relevancia.
 * El evaluador ya las devolvió ordenadas por ahorro (D4).
 */
export const pickRelevantUnlockable = (
  evaluation: PromotionEvaluation
): PromotionEvaluation['unlockable'][number] | null =>
  evaluation.unlockable.find(
    (item) => item.estimatedSaving >= PROMOTION_MIN_RELEVANT_SAVING
  ) ?? null;

/**
 * Fact: lo que es verdad del carrito ahora. Nunca gasta presupuesto.
 * Los montos vienen calculados — el modelo no hace aritmética (ADR-0010).
 */
export const buildPromotionFactLines = (
  evaluation: PromotionEvaluation
): string[] => {
  const lines: string[] = [];

  for (const applied of evaluation.applied) {
    if (applied.monetaryDiscount > 0) {
      lines.push(
        `- Promoción YA APLICADA (dato, no planteo): *${applied.name}* — ` +
          `${applied.summary}. Descuento de $${applied.monetaryDiscount.toFixed(2)} ya incluido en el total. ` +
          `Podés mencionarlo con naturalidad al confirmar. PROHIBIDO calcular o inventar montos: ` +
          `usá este número o el que devuelva get_cart.`
      );
    } else if (applied.benefitClass === 'shipping') {
      lines.push(
        `- Promoción YA APLICADA (dato, no planteo): *${applied.name}* — el envío de este pedido es gratis. ` +
          `El total ya lo refleja.`
      );
    } else {
      lines.push(
        `- Promoción YA APLICADA (dato, no planteo): *${applied.name}* — ${applied.summary}. ` +
          `El regalo se suma al pedido sin costo; no lo cobres ni lo agregues con add_cart_item.`
      );
    }
  }

  return lines;
};

export type PromotionOpportunityFacts = {
  evaluation: PromotionEvaluation;
  checkoutActive: boolean;
  /** Cola de líneas abierta: mismo criterio que SUGERIR_COMPLEMENTO (D7 multi-línea). */
  hasOpenOrderLines?: boolean;
};

export const derivePromotionOpen = (facts: PromotionOpportunityFacts): boolean => {
  if (facts.checkoutActive) return false;
  if (facts.hasOpenOrderLines) return false;
  return pickRelevantUnlockable(facts.evaluation) !== null;
};

/**
 * Candidato para el ranker. `tieBreak: 18` (D7) queda entre CONFIRMAR_OFERTA
 * (20 — continuidad de algo que el cliente ya está considerando) y
 * SUGERIR_COMPLEMENTO (15 — iniciativa del negocio sin beneficio para el
 * cliente). Es un número FIJO: un tieBreak que variara con el monto haría el
 * log de ranking irreproducible y metería política de negocio en un valor
 * volátil (ADR-0009: la presión es política, no juicio conversacional).
 */
export const derivePromotionCandidate = (
  facts: PromotionOpportunityFacts,
  ledgerEntry: IntentLedgerEntry | undefined,
  now: number = Date.now()
): IntentCandidate | null => {
  if (!derivePromotionOpen(facts)) return null;

  const unlockable = pickRelevantUnlockable(facts.evaluation);
  if (!unlockable) return null;

  if (ledgerEntry?.refused) return null;

  const perm = computeCatalogPermission(
    PROMOTION_INTENT_TYPE,
    ledgerEntry ?? {},
    now
  );
  if (!perm.granted) return null;

  const cat = getIntentCatalogEntry(PROMOTION_INTENT_TYPE);
  return {
    type: PROMOTION_INTENT_TYPE,
    kind: cat.kind,
    pressure: cat.pressure,
    closeMode: cat.closeMode,
    hint: buildPromotionHint(unlockable),
    tieBreak: 18,
  };
};

export const buildPromotionHint = (
  unlockable: PromotionEvaluation['unlockable'][number]
): string => {
  const what =
    unlockable.missing.kind === 'product'
      ? `${unlockable.missing.units} × ${unlockable.missing.productName} más`
      : `$${unlockable.missing.amount.toFixed(2)} más de pedido`;

  return (
    `- Opportunity (OFRECER_PROMOCION): con ${what} el cliente desbloquea *${unlockable.name}* ` +
    `(${unlockable.summary}), un ahorro de $${unlockable.estimatedSaving.toFixed(2)}. ` +
    `Si encaja naturalmente en este turno, contáselo en una línea y ofrecé sumarlo. ` +
    `${unlockable.missing.kind === 'product' ? 'Si acepta, add_cart_item con ese producto. ' : ''}` +
    `Presupuesto 1: si no acepta, no insistas. PROHIBIDO prometer un descuento distinto ` +
    `del indicado o calcular montos por tu cuenta.`
  );
};

export const recordPromotionSurfaced = async (
  conversationId: string,
  metadata: unknown,
  promotionId: string
): Promise<void> => {
  const meta = normalizeMetadata(metadata);
  const prev = meta.intentLedger?.[PROMOTION_INTENT_TYPE] ?? {};
  const openedAt = prev.openedAt ?? new Date().toISOString();
  const cat = getIntentCatalogEntry(PROMOTION_INTENT_TYPE);

  await patchIntentLedgerEntry(conversationId, PROMOTION_INTENT_TYPE, {
    ...prev,
    openedAt,
    expiresAt:
      prev.expiresAt ??
      (cat.ttlMs != null
        ? new Date(Date.parse(openedAt) + cat.ttlMs).toISOString()
        : null),
    surfaceCount: (prev.surfaceCount ?? 0) + 1,
    lastSurfacedAt: new Date().toISOString(),
    // Identidad, no valor: ADR-0003 permite referenciar, nunca copiar el monto.
    lastSurfacedPromotionId: promotionId,
  });
};

/**
 * D6 — Fact de supresión para el cross-sell.
 *
 * Si la promo desbloqueable apunta a un producto de una categoría que
 * `SUGERIR_COMPLEMENTO` ofrecería, las dos Opportunities empujan el MISMO
 * movimiento y el complemento mostraría a precio de lista lo que la promo
 * regala. Se suprime en el derivador leyendo este Fact — el patrón ya
 * documentado para `hasOpenOrderLines` (TAXONOMIA §6/§7): sin IntentType nuevo
 * y sin tocar el ranker.
 */
export const collectPromotionSuppressedTags = (
  evaluation: PromotionEvaluation,
  tagByProductId: Map<string, MenuCategoryTag>
): MenuCategoryTag[] => {
  const unlockable = pickRelevantUnlockable(evaluation);
  if (!unlockable) return [];

  const tags = new Set<MenuCategoryTag>();
  for (const productId of unlockable.relatedProductIds) {
    const tag = tagByProductId.get(productId);
    if (tag) tags.add(tag);
  }
  return [...tags];
};

/** Payload inyectado en la respuesta de `add_cart_item` (mismo turno ReAct). */
export type PostAddPromotion = {
  type: 'PROMOTION_APPLIED' | 'PROMOTION_UNLOCKABLE';
  instruction: string;
};

/**
 * El `[ESTADO DEL CLIENTE]` se armó ANTES del add, así que no sabe nada del
 * carrito nuevo. Igual que `resolvePostAddComplementOpportunity`, re-derivamos
 * con el carrito ya mutado y devolvemos el resultado dentro de la observación
 * de la tool, para que el 2x1 que disparó ESTE add se comunique en ESTE turno
 * y no uno tarde.
 */
export const buildPostAddPromotion = (
  evaluation: PromotionEvaluation
): PostAddPromotion | null => {
  const applied = evaluation.applied.filter(
    (item) => item.monetaryDiscount > 0 || item.benefitClass !== 'monetary'
  );

  if (applied.length > 0) {
    const detail = applied
      .map((item) =>
        item.monetaryDiscount > 0
          ? `${item.name} (${item.summary}, −$${item.monetaryDiscount.toFixed(2)})`
          : `${item.name} (${item.summary})`
      )
      .join('; ');
    return {
      type: 'PROMOTION_APPLIED',
      instruction:
        `Este add activó una promoción: ${detail}. El total devuelto YA la incluye. ` +
        `Mencionalo al confirmar, con naturalidad y sin recalcular montos.`,
    };
  }

  const unlockable = pickRelevantUnlockable(evaluation);
  if (!unlockable) return null;

  const what =
    unlockable.missing.kind === 'product'
      ? `${unlockable.missing.units} × ${unlockable.missing.productName} más`
      : `$${unlockable.missing.amount.toFixed(2)} más de pedido`;

  return {
    type: 'PROMOTION_UNLOCKABLE',
    instruction:
      `Con ${what} el cliente desbloquea *${unlockable.name}* (${unlockable.summary}), ` +
      `un ahorro de $${unlockable.estimatedSaving.toFixed(2)}. Si encaja, ofrecelo en una línea ` +
      `al confirmar el add. No insistas si no acepta.`,
  };
};

export const resolvePostAddPromotion = async (params: {
  businessId: string;
  draftOrderId: string;
  customerId?: string | null;
}): Promise<PostAddPromotion | null> => {
  try {
    const { resolveCartPromotions } = await import(
      '../promotions/resolveCartPromotions'
    );
    const evaluation = await resolveCartPromotions({
      businessId: params.businessId,
      draftOrderId: params.draftOrderId,
      customerId: params.customerId ?? null,
    });
    return buildPostAddPromotion(evaluation);
  } catch (err) {
    console.error('[promotion] resolvePostAddPromotion failed', err);
    return null;
  }
};
