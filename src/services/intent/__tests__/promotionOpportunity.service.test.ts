import { describe, expect, it } from 'vitest';
import {
  buildPostAddPromotion,
  buildPromotionFactLines,
  collectPromotionSuppressedTags,
  derivePromotionCandidate,
  pickRelevantUnlockable,
  PROMOTION_MIN_RELEVANT_SAVING,
} from '../promotionOpportunity.service';
import {
  emptyPromotionEvaluation,
  type PromotionEvaluation,
} from '../../promotions/promotionEvaluation.types';
import type { StructuredOffer } from '../../promotions/promotionOffer.types';

const offer: StructuredOffer = { name: 'Promo', conditions: [], benefit: null };

const withApplied = (
  overrides: Partial<PromotionEvaluation['applied'][number]> = {}
): PromotionEvaluation => ({
  ...emptyPromotionEvaluation(10000),
  applied: [
    {
      promotionId: 'promo-1',
      name: '2x1 en hamburguesas',
      benefitType: 'nth_free',
      benefitClass: 'monetary',
      monetaryDiscount: 5000,
      savingValue: 5000,
      summary: '2x1 en hamburguesa (1 gratis)',
      offerSnapshot: offer,
      ...overrides,
    },
  ],
  monetaryDiscount: overrides.monetaryDiscount ?? 5000,
});

const withUnlockable = (estimatedSaving = 5000): PromotionEvaluation => ({
  ...emptyPromotionEvaluation(5000),
  unlockable: [
    {
      promotionId: 'promo-1',
      name: '2x1 en hamburguesas',
      benefitType: 'nth_free',
      benefitClass: 'monetary',
      missing: {
        kind: 'product',
        productId: 'item-hamburguesa',
        productName: 'hamburguesa',
        units: 1,
      },
      estimatedSaving,
      relatedProductIds: ['item-hamburguesa'],
      summary: 'sumando 1 × hamburguesa',
    },
  ],
});

describe('Fact ≠ Opportunity (precedente de lastOffer)', () => {
  it('la promo aplicada se comunica aunque el presupuesto esté agotado', () => {
    const evaluation = withApplied();
    const lines = buildPromotionFactLines(evaluation);
    expect(lines[0]).toContain('YA APLICADA');
    expect(lines[0]).toContain('5000.00');

    // Mismo estado, con el ledger exhausto: el Fact sigue; la Opportunity no.
    const candidate = derivePromotionCandidate(
      { evaluation: withUnlockable(), checkoutActive: false },
      { surfaceCount: 1 }
    );
    expect(candidate).toBeNull();
    expect(buildPromotionFactLines(evaluation)).toHaveLength(1);
  });

  it('la promo aplicada se comunica aunque el cliente haya rechazado plantear', () => {
    expect(buildPromotionFactLines(withApplied())).toHaveLength(1);
    expect(
      derivePromotionCandidate(
        { evaluation: withUnlockable(), checkoutActive: false },
        { refused: true }
      )
    ).toBeNull();
  });

  it('sin promociones no hay líneas de Fact', () => {
    expect(buildPromotionFactLines(emptyPromotionEvaluation())).toEqual([]);
  });

  it('el Fact de envío gratis y el de regalo tienen copy propio', () => {
    const envio = withApplied({
      benefitClass: 'shipping',
      benefitType: 'free_shipping',
      monetaryDiscount: 0,
    });
    envio.monetaryDiscount = 0;
    expect(buildPromotionFactLines(envio)[0]).toContain('envío');

    const regalo = withApplied({
      benefitClass: 'gift',
      benefitType: 'free_product',
      monetaryDiscount: 0,
      summary: '1 × papas de regalo',
    });
    regalo.monetaryDiscount = 0;
    expect(buildPromotionFactLines(regalo)[0]).toContain('no lo cobres');
  });
});

describe('derivePromotionCandidate — permiso y relevancia', () => {
  it('emite candidato con tieBreak 18 (entre oferta viva y complemento)', () => {
    const candidate = derivePromotionCandidate(
      { evaluation: withUnlockable(), checkoutActive: false },
      {}
    );
    expect(candidate?.type).toBe('OFRECER_PROMOCION');
    expect(candidate?.tieBreak).toBe(18);
    expect(candidate?.kind).toBe('opportunity');
  });

  it('D14: por debajo del umbral de relevancia no se plantea', () => {
    const candidate = derivePromotionCandidate(
      { evaluation: withUnlockable(PROMOTION_MIN_RELEVANT_SAVING - 1), checkoutActive: false },
      {}
    );
    expect(candidate).toBeNull();
  });

  it('justo en el umbral sí se plantea', () => {
    expect(
      derivePromotionCandidate(
        { evaluation: withUnlockable(PROMOTION_MIN_RELEVANT_SAVING), checkoutActive: false },
        {}
      )
    ).not.toBeNull();
  });

  it('no se plantea con checkout activo', () => {
    expect(
      derivePromotionCandidate(
        { evaluation: withUnlockable(), checkoutActive: true },
        {}
      )
    ).toBeNull();
  });

  it('no se plantea con cola de líneas abierta', () => {
    expect(
      derivePromotionCandidate(
        { evaluation: withUnlockable(), checkoutActive: false, hasOpenOrderLines: true },
        {}
      )
    ).toBeNull();
  });

  it('el hint trae el monto ya calculado y prohíbe recalcular', () => {
    const candidate = derivePromotionCandidate(
      { evaluation: withUnlockable(), checkoutActive: false },
      {}
    );
    expect(candidate?.hint).toContain('1 × hamburguesa más');
    expect(candidate?.hint).toContain('5000.00');
    expect(candidate?.hint).toContain('PROHIBIDO');
  });
});

describe('supresión del cross-sell (D6)', () => {
  it('devuelve las categorías que la promo desbloqueable ya empuja', () => {
    const tags = collectPromotionSuppressedTags(
      withUnlockable(),
      new Map([['item-hamburguesa', 'MAIN' as const]])
    );
    expect(tags).toEqual(['MAIN']);
  });

  it('sin promo relevante no suprime nada', () => {
    expect(
      collectPromotionSuppressedTags(emptyPromotionEvaluation(), new Map())
    ).toEqual([]);
  });

  it('un producto sin tag conocido no suprime', () => {
    expect(collectPromotionSuppressedTags(withUnlockable(), new Map())).toEqual([]);
  });
});

describe('reinyección post-add', () => {
  it('la promo aplicada gana a la desbloqueable', () => {
    const evaluation: PromotionEvaluation = {
      ...withApplied(),
      unlockable: withUnlockable().unlockable,
    };
    const result = buildPostAddPromotion(evaluation);
    expect(result?.type).toBe('PROMOTION_APPLIED');
    expect(result?.instruction).toContain('YA la incluye');
  });

  it('sin aplicada, ofrece la desbloqueable', () => {
    const result = buildPostAddPromotion(withUnlockable());
    expect(result?.type).toBe('PROMOTION_UNLOCKABLE');
    expect(result?.instruction).toContain('1 × hamburguesa más');
  });

  it('respeta el umbral de relevancia', () => {
    expect(buildPostAddPromotion(withUnlockable(100))).toBeNull();
  });

  it('sin promociones no inyecta nada', () => {
    expect(buildPostAddPromotion(emptyPromotionEvaluation())).toBeNull();
  });
});

describe('pickRelevantUnlockable', () => {
  it('devuelve la primera que supera el umbral (ya vienen ordenadas)', () => {
    const evaluation = withUnlockable(600);
    evaluation.unlockable.push({
      ...evaluation.unlockable[0]!,
      promotionId: 'promo-2',
      estimatedSaving: 10000,
    });
    expect(pickRelevantUnlockable(evaluation)?.promotionId).toBe('promo-1');
  });
});
