import { describe, expect, it } from 'vitest';
import {
  assertPromotionComplete,
  assertTransition,
  canTransition,
  collectProductPaths,
  PromotionIncompleteError,
  PromotionInvalidTransitionError,
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
