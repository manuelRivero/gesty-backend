import { describe, expect, it } from 'vitest';
import {
  collectConditionProblems,
  collectUnsupportedLimits,
  describeBenefitProblems,
  findAmbiguousGift,
  isEvaluableCondition,
  toEvaluableCondition,
} from '../promotionConditions';
import type { Benefit, Condition, StructuredOffer } from '../promotionOffer.types';

const offerWith = (partial: Partial<StructuredOffer>): StructuredOffer => ({
  name: 'Promo',
  conditions: [],
  benefit: null,
  ...partial,
});

describe('promotionConditions — whitelist del DSL (D1)', () => {
  describe('condiciones válidas', () => {
    it.each<Condition>([
      { field: 'cart.product', operator: 'gte', value: { productName: 'hamburguesa', quantity: 2 } },
      { field: 'cart.product', operator: 'eq', value: { productName: 'pizza' } },
      { field: 'cart.subtotal', operator: 'gte', value: 15000 },
      { field: 'cart.subtotal', operator: 'lt', value: 5000 },
      { field: 'cart.itemCount', operator: 'gte', value: 3 },
      { field: 'order.isFirstPurchase', operator: 'eq', value: true },
    ])('acepta %o', (condition) => {
      expect(isEvaluableCondition(condition)).toBe(true);
    });

    it('normaliza el nombre de producto y conserva la cantidad', () => {
      const parsed = toEvaluableCondition({
        field: 'cart.product',
        operator: 'gte',
        value: { productName: '  hamburguesa  ', quantity: 2 },
      });
      expect(parsed).toEqual({
        field: 'cart.product',
        operator: 'gte',
        value: { productName: 'hamburguesa', quantity: 2 },
      });
    });
  });

  describe('condiciones inválidas', () => {
    it('rechaza un campo fuera de la whitelist', () => {
      const condition: Condition = {
        field: 'cart.total_after_discount',
        operator: 'gte',
        value: 5000,
      };
      expect(isEvaluableCondition(condition)).toBe(false);
      expect(collectConditionProblems(offerWith({ conditions: [condition] }))[0]).toContain(
        'campo no soportado'
      );
    });

    it('rechaza `order.shipping` (campo huérfano que solo existía en el display)', () => {
      expect(
        isEvaluableCondition({ field: 'order.shipping', operator: 'eq', value: 'free' })
      ).toBe(false);
    });

    it('rechaza un operador sin semántica para el campo', () => {
      const condition: Condition = {
        field: 'cart.subtotal',
        operator: 'contains',
        value: 5000,
      };
      expect(isEvaluableCondition(condition)).toBe(false);
      expect(collectConditionProblems(offerWith({ conditions: [condition] }))[0]).toContain(
        'no tiene semántica'
      );
    });

    it('rechaza `contains` sobre cart.product (no define qué comparar)', () => {
      expect(
        isEvaluableCondition({
          field: 'cart.product',
          operator: 'contains',
          value: { productName: 'hamburguesa' },
        })
      ).toBe(false);
    });

    it('rechaza un value con la forma equivocada', () => {
      expect(
        isEvaluableCondition({ field: 'cart.product', operator: 'gte', value: 'hamburguesa' })
      ).toBe(false);
      expect(
        isEvaluableCondition({ field: 'cart.itemCount', operator: 'gte', value: 2.5 })
      ).toBe(false);
      expect(
        isEvaluableCondition({ field: 'order.isFirstPurchase', operator: 'eq', value: 'sí' })
      ).toBe(false);
      expect(
        isEvaluableCondition({ field: 'cart.subtotal', operator: 'gte', value: 0 })
      ).toBe(false);
    });

    it('rechaza una cantidad de producto no entera o menor a 1', () => {
      expect(
        isEvaluableCondition({
          field: 'cart.product',
          operator: 'gte',
          value: { productName: 'pizza', quantity: 0 },
        })
      ).toBe(false);
      expect(
        isEvaluableCondition({
          field: 'cart.product',
          operator: 'gte',
          value: { productName: 'pizza', quantity: 1.5 },
        })
      ).toBe(false);
    });
  });
});

describe('promotionConditions — beneficios (D2)', () => {
  it('exige target en beneficios monetarios', () => {
    const problems = describeBenefitProblems({
      type: 'percentage_discount',
      value: 50,
    } as Benefit);
    expect(problems[0]).toContain('sobre qué se aplica');
  });

  it('acepta un beneficio monetario con target de pedido', () => {
    expect(
      describeBenefitProblems({
        type: 'percentage_discount',
        value: 10,
        target: { scope: 'order' },
      })
    ).toEqual([]);
  });

  it('rechaza un target de producto sin nombre', () => {
    const problems = describeBenefitProblems({
      type: 'fixed_discount',
      value: 1000,
      target: { scope: 'product', productName: '  ' },
    } as Benefit);
    expect(problems[0]).toContain('no dice cuál');
  });

  it('no exige target a nth_free (ya nombra su producto)', () => {
    expect(
      describeBenefitProblems({
        type: 'nth_free',
        productName: 'hamburguesa',
        buyQuantity: 2,
        freeQuantity: 1,
        repeats: true,
      })
    ).toEqual([]);
  });

  it('rechaza nth_free donde todo saldría gratis', () => {
    const problems = describeBenefitProblems({
      type: 'nth_free',
      productName: 'hamburguesa',
      buyQuantity: 2,
      freeQuantity: 2,
      repeats: true,
    });
    expect(problems[0]).toContain('menor que la comprada');
  });

  it('rechaza nth_free con buyQuantity < 2', () => {
    const problems = describeBenefitProblems({
      type: 'nth_free',
      productName: 'hamburguesa',
      buyQuantity: 1,
      freeQuantity: 1,
      repeats: false,
    });
    expect(problems.join(' ')).toContain('al menos 2');
  });

  it('no exige target a free_product ni a free_shipping', () => {
    expect(
      describeBenefitProblems({ type: 'free_product', productName: 'papas', quantity: 1 })
    ).toEqual([]);
    expect(describeBenefitProblems({ type: 'free_shipping' })).toEqual([]);
  });
});

describe('promotionConditions — regalo ambiguo (D2)', () => {
  const offer = offerWith({
    conditions: [
      {
        field: 'cart.product',
        operator: 'gte',
        value: { productName: 'hamburguesa', quantity: 2 },
      },
    ],
    benefit: { type: 'free_product', productName: 'hamburguesa', quantity: 1 },
  });

  it('detecta el 2x1 encubierto: el regalo es el mismo menu_item que la condición', () => {
    const problem = findAmbiguousGift({
      offer,
      menuItemIdByPath: new Map([
        ['offer.conditions[0].value.productName', 'item-1'],
        ['offer.benefit.productName', 'item-1'],
      ]),
    });
    expect(problem).toContain('nth_free');
  });

  it('no marca ambigüedad si el regalo es otro platillo', () => {
    expect(
      findAmbiguousGift({
        offer,
        menuItemIdByPath: new Map([
          ['offer.conditions[0].value.productName', 'item-1'],
          ['offer.benefit.productName', 'item-2'],
        ]),
      })
    ).toBeNull();
  });

  it('no marca ambigüedad cuando el beneficio no es un regalo', () => {
    expect(
      findAmbiguousGift({
        offer: offerWith({
          benefit: { type: 'free_shipping' },
        }),
        menuItemIdByPath: new Map(),
      })
    ).toBeNull();
  });
});

describe('promotionConditions — límites no soportados (B7)', () => {
  it('rechaza maxUsesTotal y maxUsesPerCustomer', () => {
    const problems = collectUnsupportedLimits(
      offerWith({ limits: { maxUsesTotal: 100, maxUsesPerCustomer: 1 } })
    );
    expect(problems).toHaveLength(2);
  });

  it('no se queja si no hay límites declarados', () => {
    expect(collectUnsupportedLimits(offerWith({}))).toEqual([]);
  });
});
