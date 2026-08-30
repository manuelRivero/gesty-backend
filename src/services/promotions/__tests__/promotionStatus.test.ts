import { describe, expect, it } from 'vitest';
import {
  assertPromotionActivatable,
  assertPromotionComplete,
  assertTransition,
  canTransition,
  collectProductPaths,
  PromotionAmbiguousBenefitError,
  PromotionIncompleteError,
  PromotionInvalidTransitionError,
  PromotionNotEvaluableError,
} from '../promotionStatus';
import type { StructuredOffer } from '../promotionOffer.types';

const offerConPapas: StructuredOffer = {
  name: 'Martes de hamburguesas',
  conditions: [
    {
      field: 'cart.product',
      operator: 'gte',
      value: { productName: 'hamburguesa', quantity: 1 },
    },
  ],
  benefit: { type: 'free_product', productName: 'papas fritas', quantity: 1 },
  validity: { daysOfWeek: [2], timeRange: { from: '18:00', to: '20:00' } },
};

describe('máquina de estados', () => {
  it('permite draft → active y active → paused', () => {
    expect(canTransition('draft', 'active')).toBe(true);
    expect(canTransition('active', 'paused')).toBe(true);
    expect(canTransition('paused', 'active')).toBe(true);
  });

  it('archived es terminal', () => {
    expect(canTransition('archived', 'active')).toBe(false);
    expect(() => assertTransition('archived', 'draft')).toThrow(
      PromotionInvalidTransitionError
    );
  });

  it('acepta la transición al mismo estado', () => {
    expect(canTransition('draft', 'draft')).toBe(true);
  });
});

describe('collectProductPaths', () => {
  it('junta productos de condiciones y beneficio con su path', () => {
    expect(collectProductPaths(offerConPapas)).toEqual([
      {
        path: 'offer.conditions[0].value.productName',
        text: 'hamburguesa',
        role: 'condition',
      },
      { path: 'offer.benefit.productName', text: 'papas fritas', role: 'benefit' },
    ]);
  });
});

describe('assertPromotionComplete', () => {
  it('pasa cuando todo producto está vinculado', () => {
    expect(() =>
      assertPromotionComplete({
        offer: offerConPapas,
        productLinks: [
          {
            path: 'offer.conditions[0].value.productName',
            role: 'condition',
            menuItemId: 'a',
            sourceText: 'hamburguesa',
          },
          {
            path: 'offer.benefit.productName',
            role: 'benefit',
            menuItemId: 'b',
            sourceText: 'papas fritas',
          },
        ],
      })
    ).not.toThrow();
  });

  it('rechaza si falta vincular un producto (D6)', () => {
    try {
      assertPromotionComplete({
        offer: offerConPapas,
        productLinks: [
          {
            path: 'offer.conditions[0].value.productName',
            role: 'condition',
            menuItemId: 'a',
            sourceText: 'hamburguesa',
          },
        ],
      });
      throw new Error('debió lanzar');
    } catch (error) {
      expect(error).toBeInstanceOf(PromotionIncompleteError);
      expect((error as PromotionIncompleteError).missing).toEqual([
        'Falta vincular "papas fritas" con un platillo del menú',
      ]);
    }
  });

  it('rechaza si no hay beneficio', () => {
    try {
      assertPromotionComplete({
        offer: { name: 'X', conditions: [], benefit: null },
        productLinks: [],
      });
      throw new Error('debió lanzar');
    } catch (error) {
      expect(error).toBeInstanceOf(PromotionIncompleteError);
      expect((error as PromotionIncompleteError).missing[0]).toContain('beneficio');
    }
  });

  it('acepta una promo sin productos (envío gratis por monto)', () => {
    expect(() =>
      assertPromotionComplete({
        offer: {
          name: 'Envío gratis',
          conditions: [{ field: 'cart.subtotal', operator: 'gt', value: 40000 }],
          benefit: { type: 'free_shipping' },
        },
        productLinks: [],
      })
    ).not.toThrow();
  });
});

describe('assertPromotionActivatable — gate de activación (D1/D2/B7)', () => {
  const linkHamburguesa = {
    path: 'offer.conditions[0].value.productName',
    role: 'condition' as const,
    menuItemId: 'item-hamburguesa',
    sourceText: 'hamburguesa',
  };

  const baseOffer: StructuredOffer = {
    name: 'Promo',
    conditions: [
      {
        field: 'cart.product',
        operator: 'gte',
        value: { productName: 'hamburguesa', quantity: 2 },
      },
    ],
    benefit: {
      type: 'nth_free',
      productName: 'hamburguesa',
      buyQuantity: 2,
      freeQuantity: 1,
      repeats: true,
    },
  };

  const links = [
    linkHamburguesa,
    {
      path: 'offer.benefit.productName',
      role: 'benefit' as const,
      menuItemId: 'item-hamburguesa',
      sourceText: 'hamburguesa',
    },
  ];

  it('acepta un 2x1 bien expresado', () => {
    expect(() =>
      assertPromotionActivatable({ offer: baseOffer, productLinks: links })
    ).not.toThrow();
  });

  it('rechaza una condición con campo fuera de la whitelist', () => {
    expect(() =>
      assertPromotionActivatable({
        offer: {
          ...baseOffer,
          conditions: [
            { field: 'cart.total_after_discount', operator: 'gte', value: 5000 },
          ],
        },
        productLinks: links,
      })
    ).toThrow(PromotionNotEvaluableError);
  });

  it('rechaza un descuento monetario sin target', () => {
    expect(() =>
      assertPromotionActivatable({
        offer: {
          ...baseOffer,
          benefit: { type: 'percentage_discount', value: 20 },
        },
        productLinks: [linkHamburguesa],
      })
    ).toThrow(PromotionNotEvaluableError);
  });

  it('rechaza límites de uso que no podemos hacer cumplir (B7)', () => {
    expect(() =>
      assertPromotionActivatable({
        offer: { ...baseOffer, limits: { maxUsesTotal: 50 } },
        productLinks: links,
      })
    ).toThrow(PromotionNotEvaluableError);
  });

  it('rechaza el 2x1 encubierto como free_product del mismo platillo', () => {
    expect(() =>
      assertPromotionActivatable({
        offer: {
          ...baseOffer,
          benefit: { type: 'free_product', productName: 'hamburguesa', quantity: 1 },
        },
        productLinks: links,
      })
    ).toThrow(PromotionAmbiguousBenefitError);
  });

  it('sigue exigiendo completitud (beneficio presente y productos vinculados)', () => {
    expect(() =>
      assertPromotionActivatable({
        offer: { ...baseOffer, benefit: null },
        productLinks: links,
      })
    ).toThrow(PromotionIncompleteError);
  });
});

describe('collectProductPaths — beneficios nuevos (D2)', () => {
  it('incluye el producto de nth_free', () => {
    const paths = collectProductPaths({
      name: 'Promo',
      conditions: [],
      benefit: {
        type: 'nth_free',
        productName: 'hamburguesa',
        buyQuantity: 2,
        freeQuantity: 1,
        repeats: true,
      },
    });
    expect(paths).toEqual([
      { path: 'offer.benefit.productName', text: 'hamburguesa', role: 'benefit' },
    ]);
  });

  it('incluye el producto del target de un descuento monetario', () => {
    const paths = collectProductPaths({
      name: 'Promo',
      conditions: [],
      benefit: {
        type: 'percentage_discount',
        value: 50,
        target: { scope: 'product', productName: 'pizza', units: 1 },
      },
    });
    expect(paths).toEqual([
      { path: 'offer.benefit.target.productName', text: 'pizza', role: 'benefit' },
    ]);
  });
});
