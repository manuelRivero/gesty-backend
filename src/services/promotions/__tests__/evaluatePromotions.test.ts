import { describe, expect, it } from 'vitest';
import { evaluatePromotions, isPromotionInValidityWindow } from '../evaluatePromotions';
import type {
  EvaluatorCartLine,
  EvaluatorPromotion,
} from '../promotionEvaluation.types';
import type { Benefit, Condition, StructuredOffer } from '../promotionOffer.types';

const TZ = 'America/Argentina/Buenos_Aires';
const HAMBURGUESA = 'item-hamburguesa';
const PAPAS = 'item-papas';

/** Martes 2026-09-01, 19:00 hora de Buenos Aires (UTC-3). */
const MARTES_19H = new Date('2026-09-01T22:00:00.000Z');

const line = (
  partial: Partial<EvaluatorCartLine> & { productId: string }
): EvaluatorCartLine => ({
  productName: 'Producto',
  quantity: 1,
  unitPrice: 5000,
  variation: null,
  ...partial,
});

const promo = (params: {
  id?: string;
  name?: string;
  conditions?: Condition[];
  benefit: Benefit | null;
  validity?: StructuredOffer['validity'];
  stacking?: StructuredOffer['stacking'];
  menuItemIdByPath?: Record<string, string>;
  endsAt?: string | null;
}): EvaluatorPromotion => ({
  id: params.id ?? 'promo-1',
  name: params.name ?? 'Promo',
  offer: {
    name: params.name ?? 'Promo',
    conditions: params.conditions ?? [],
    benefit: params.benefit,
    validity: params.validity,
    stacking: params.stacking,
  },
  menuItemIdByPath: params.menuItemIdByPath ?? {},
  endsAt: params.endsAt ?? null,
});

const evaluate = (
  cartLines: EvaluatorCartLine[],
  promotions: EvaluatorPromotion[],
  options?: Parameters<typeof evaluatePromotions>[1]
) =>
  evaluatePromotions(
    {
      cartLines,
      promotions,
      customerFacts: { isFirstPurchase: false },
      now: MARTES_19H,
      timezone: TZ,
    },
    options
  );

const dosPorUno = (overrides: Partial<Parameters<typeof promo>[0]> = {}) =>
  promo({
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
    menuItemIdByPath: {
      'offer.conditions[0].value.productName': HAMBURGUESA,
      'offer.benefit.productName': HAMBURGUESA,
    },
    ...overrides,
  });

describe('evaluatePromotions — invariantes', () => {
  it('es idempotente: mismas entradas, mismo resultado', () => {
    const cart = [line({ productId: HAMBURGUESA, quantity: 2 })];
    const first = evaluate(cart, [dosPorUno()]);
    const second = evaluate(cart, [dosPorUno()]);
    const third = evaluate(cart, [dosPorUno()]);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it('no muta el carrito recibido', () => {
    const cart = [line({ productId: HAMBURGUESA, quantity: 1 })];
    const snapshot = JSON.parse(JSON.stringify(cart));
    evaluate(cart, [dosPorUno()]);
    expect(cart).toEqual(snapshot);
  });

  it('carrito vacío o sin promos → evaluación vacía', () => {
    expect(evaluate([], [dosPorUno()]).monetaryDiscount).toBe(0);
    expect(evaluate([line({ productId: HAMBURGUESA })], []).applied).toEqual([]);
  });

  it('nunca descuenta más que el total de ítems', () => {
    const result = evaluate(
      [line({ productId: HAMBURGUESA, quantity: 1, unitPrice: 1000 })],
      [
        promo({
          benefit: { type: 'fixed_discount', value: 999999, target: { scope: 'order' } },
        }),
      ]
    );
    expect(result.monetaryDiscount).toBe(1000);
  });
});

describe('evaluatePromotions — nth_free (2x1 / 3x2)', () => {
  it('2 unidades → 1 gratis', () => {
    const result = evaluate([line({ productId: HAMBURGUESA, quantity: 2 })], [dosPorUno()]);
    expect(result.monetaryDiscount).toBe(5000);
    expect(result.applied[0]?.summary).toContain('2x1');
  });

  it('6 unidades con repeats → 3 gratis (no 1)', () => {
    const result = evaluate([line({ productId: HAMBURGUESA, quantity: 6 })], [dosPorUno()]);
    expect(result.monetaryDiscount).toBe(15000);
  });

  it('6 unidades sin repeats → 1 sola gratis', () => {
    const noRepeat = dosPorUno();
    (noRepeat.offer.benefit as { repeats: boolean }).repeats = false;
    const result = evaluate([line({ productId: HAMBURGUESA, quantity: 6 })], [noRepeat]);
    expect(result.monetaryDiscount).toBe(5000);
  });

  it('3x2: 6 unidades → 2 gratis', () => {
    const tresPorDos = promo({
      conditions: [
        {
          field: 'cart.product',
          operator: 'gte',
          value: { productName: 'pizza', quantity: 3 },
        },
      ],
      benefit: {
        type: 'nth_free',
        productName: 'pizza',
        buyQuantity: 3,
        freeQuantity: 1,
        repeats: true,
      },
      menuItemIdByPath: {
        'offer.conditions[0].value.productName': HAMBURGUESA,
        'offer.benefit.productName': HAMBURGUESA,
      },
    });
    const result = evaluate([line({ productId: HAMBURGUESA, quantity: 6 })], [tresPorDos]);
    expect(result.monetaryDiscount).toBe(10000);
  });

  it('D12: regala la unidad MÁS BARATA, al precio efectivo', () => {
    const result = evaluate(
      [
        line({ productId: HAMBURGUESA, quantity: 1, unitPrice: 8000, variation: 'especial' }),
        line({ productId: HAMBURGUESA, quantity: 1, unitPrice: 4000, variation: 'simple' }),
      ],
      [dosPorUno()]
    );
    expect(result.monetaryDiscount).toBe(4000);
  });

  it('D13/B6: variaciones distintas del mismo producto suman para la condición', () => {
    const result = evaluate(
      [
        line({ productId: HAMBURGUESA, quantity: 1, variation: 'roquefort' }),
        line({ productId: HAMBURGUESA, quantity: 1, variation: 'especial' }),
      ],
      [dosPorUno()]
    );
    expect(result.applied).toHaveLength(1);
  });
});

describe('evaluatePromotions — beneficios monetarios con target', () => {
  it('porcentaje sobre el pedido', () => {
    const result = evaluate(
      [line({ productId: HAMBURGUESA, quantity: 2, unitPrice: 5000 })],
      [promo({ benefit: { type: 'percentage_discount', value: 10, target: { scope: 'order' } } })]
    );
    expect(result.monetaryDiscount).toBe(1000);
  });

  it('porcentaje sobre 1 unidad de un producto (segunda unidad al 50%)', () => {
    const result = evaluate(
      [line({ productId: HAMBURGUESA, quantity: 2, unitPrice: 5000 })],
      [
        promo({
          benefit: {
            type: 'percentage_discount',
            value: 50,
            target: { scope: 'product', productName: 'hamburguesa', units: 1 },
          },
          menuItemIdByPath: { 'offer.benefit.target.productName': HAMBURGUESA },
        }),
      ]
    );
    expect(result.monetaryDiscount).toBe(2500);
  });

  it('el mismo 50% con target de pedido da un monto MUY distinto', () => {
    const result = evaluate(
      [line({ productId: HAMBURGUESA, quantity: 2, unitPrice: 5000 })],
      [promo({ benefit: { type: 'percentage_discount', value: 50, target: { scope: 'order' } } })]
    );
    expect(result.monetaryDiscount).toBe(5000);
  });

  it('descuento fijo nunca supera el total del producto apuntado', () => {
    const result = evaluate(
      [line({ productId: HAMBURGUESA, quantity: 1, unitPrice: 1000 })],
      [
        promo({
          benefit: {
            type: 'fixed_discount',
            value: 5000,
            target: { scope: 'product', productName: 'hamburguesa' },
          },
          menuItemIdByPath: { 'offer.benefit.target.productName': HAMBURGUESA },
        }),
      ]
    );
    expect(result.monetaryDiscount).toBe(1000);
  });

  it('precio fijo por producto descuenta la diferencia', () => {
    const result = evaluate(
      [line({ productId: HAMBURGUESA, quantity: 1, unitPrice: 10000 })],
      [
        promo({
          benefit: {
            type: 'fixed_price',
            value: 8000,
            target: { scope: 'product', productName: 'hamburguesa' },
          },
          menuItemIdByPath: { 'offer.benefit.target.productName': HAMBURGUESA },
        }),
      ]
    );
    expect(result.monetaryDiscount).toBe(2000);
  });
});

describe('evaluatePromotions — regalo y envío no descuentan dinero (D3)', () => {
  it('free_product produce una línea de regalo, no un descuento', () => {
    const result = evaluate(
      [line({ productId: HAMBURGUESA, quantity: 1 })],
      [
        promo({
          conditions: [
            {
              field: 'cart.product',
              operator: 'gte',
              value: { productName: 'hamburguesa', quantity: 1 },
            },
          ],
          benefit: { type: 'free_product', productName: 'papas', quantity: 1 },
          menuItemIdByPath: {
            'offer.conditions[0].value.productName': HAMBURGUESA,
            'offer.benefit.productName': PAPAS,
          },
        }),
      ],
      { catalogPriceByProductId: { [PAPAS]: 3000 } }
    );
    expect(result.monetaryDiscount).toBe(0);
    expect(result.giftItems).toEqual([
      {
        promotionId: 'promo-1',
        productId: PAPAS,
        productName: 'papas',
        quantity: 1,
        estimatedValue: 3000,
      },
    ]);
  });

  it('free_shipping marca la bandera y no descuenta ítems', () => {
    const result = evaluate(
      [line({ productId: HAMBURGUESA, quantity: 1 })],
      [promo({ benefit: { type: 'free_shipping' } })],
      { deliveryFee: 2500 }
    );
    expect(result.freeShipping).toBe(true);
    expect(result.monetaryDiscount).toBe(0);
    expect(result.applied[0]?.savingValue).toBe(2500);
  });
});

describe('evaluatePromotions — stacking por clases disjuntas (D4)', () => {
  const envioGratis = promo({
    id: 'promo-envio',
    benefit: { type: 'free_shipping' },
  });
  const regalo = promo({
    id: 'promo-regalo',
    benefit: { type: 'free_product', productName: 'papas', quantity: 1 },
    menuItemIdByPath: { 'offer.benefit.productName': PAPAS },
  });

  it('combina una promo de cada clase', () => {
    const result = evaluate(
      [line({ productId: HAMBURGUESA, quantity: 2 })],
      [dosPorUno(), envioGratis, regalo],
      { deliveryFee: 2000, catalogPriceByProductId: { [PAPAS]: 3000 } }
    );
    expect(result.applied.map((a) => a.benefitClass).sort()).toEqual([
      'gift',
      'monetary',
      'shipping',
    ]);
  });

  it('no combina dos monetarias: gana la de mayor ahorro', () => {
    const chica = promo({
      id: 'promo-chica',
      benefit: { type: 'percentage_discount', value: 5, target: { scope: 'order' } },
    });
    const grande = promo({
      id: 'promo-grande',
      benefit: { type: 'percentage_discount', value: 30, target: { scope: 'order' } },
    });
    const result = evaluate([line({ productId: HAMBURGUESA, quantity: 2 })], [chica, grande]);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.promotionId).toBe('promo-grande');
    expect(result.monetaryDiscount).toBe(3000);
  });

  it('stacking.allowed=false actúa como cerrojo exclusivo', () => {
    const exclusiva = promo({
      id: 'promo-exclusiva',
      benefit: { type: 'percentage_discount', value: 30, target: { scope: 'order' } },
      stacking: { allowed: false },
    });
    const result = evaluate(
      [line({ productId: HAMBURGUESA, quantity: 2 })],
      [exclusiva, envioGratis],
      { deliveryFee: 2000 }
    );
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.promotionId).toBe('promo-exclusiva');
    expect(result.freeShipping).toBe(false);
  });

  it('desempate estable por id cuando el ahorro y el vencimiento coinciden', () => {
    const a = promo({
      id: 'aaa',
      benefit: { type: 'percentage_discount', value: 10, target: { scope: 'order' } },
    });
    const b = promo({
      id: 'bbb',
      benefit: { type: 'percentage_discount', value: 10, target: { scope: 'order' } },
    });
    const cart = [line({ productId: HAMBURGUESA, quantity: 2 })];
    expect(evaluate(cart, [a, b]).applied[0]?.promotionId).toBe('aaa');
    expect(evaluate(cart, [b, a]).applied[0]?.promotionId).toBe('aaa');
  });

  it('con igual ahorro gana la que vence primero', () => {
    const tarde = promo({
      id: 'aaa-tarde',
      benefit: { type: 'percentage_discount', value: 10, target: { scope: 'order' } },
      endsAt: '2026-12-31T00:00:00.000Z',
    });
    const pronto = promo({
      id: 'zzz-pronto',
      benefit: { type: 'percentage_discount', value: 10, target: { scope: 'order' } },
      endsAt: '2026-09-30T00:00:00.000Z',
    });
    const result = evaluate([line({ productId: HAMBURGUESA, quantity: 2 })], [tarde, pronto]);
    expect(result.applied[0]?.promotionId).toBe('zzz-pronto');
  });
});

describe('evaluatePromotions — desbloqueables', () => {
  it('falta 1 unidad → unlockable con el ahorro estimado', () => {
    const result = evaluate([line({ productId: HAMBURGUESA, quantity: 1 })], [dosPorUno()], {
      catalogPriceByProductId: { [HAMBURGUESA]: 5000 },
    });
    expect(result.applied).toEqual([]);
    expect(result.unlockable).toHaveLength(1);
    expect(result.unlockable[0]?.missing).toEqual({
      kind: 'product',
      productId: HAMBURGUESA,
      productName: 'hamburguesa',
      units: 1,
    });
    expect(result.unlockable[0]?.estimatedSaving).toBe(5000);
  });

  it('falta monto para el mínimo de subtotal', () => {
    const result = evaluate(
      [line({ productId: HAMBURGUESA, quantity: 1, unitPrice: 8000 })],
      [
        promo({
          conditions: [{ field: 'cart.subtotal', operator: 'gte', value: 10000 }],
          benefit: { type: 'free_shipping' },
        }),
      ],
      { deliveryFee: 2500 }
    );
    expect(result.unlockable[0]?.missing).toEqual({ kind: 'subtotal', amount: 2000 });
  });

  it('no ofrece desbloqueo cuando la condición es inalcanzable sumando', () => {
    const result = evaluate(
      [line({ productId: HAMBURGUESA, quantity: 5, unitPrice: 5000 })],
      [
        promo({
          conditions: [{ field: 'cart.subtotal', operator: 'lt', value: 10000 }],
          benefit: { type: 'free_shipping' },
        }),
      ],
      { deliveryFee: 2500 }
    );
    expect(result.unlockable).toEqual([]);
  });

  it('no ofrece desbloqueo si faltan DOS condiciones', () => {
    const result = evaluate(
      [line({ productId: PAPAS, quantity: 1, unitPrice: 1000 })],
      [
        promo({
          conditions: [
            {
              field: 'cart.product',
              operator: 'gte',
              value: { productName: 'hamburguesa', quantity: 2 },
            },
            { field: 'cart.subtotal', operator: 'gte', value: 50000 },
          ],
          benefit: { type: 'nth_free', productName: 'hamburguesa', buyQuantity: 2, freeQuantity: 1, repeats: true },
          menuItemIdByPath: {
            'offer.conditions[0].value.productName': HAMBURGUESA,
            'offer.benefit.productName': HAMBURGUESA,
          },
        }),
      ]
    );
    expect(result.unlockable).toEqual([]);
  });

  it('ordena los desbloqueables por ahorro descendente', () => {
    const chico = promo({
      id: 'chico',
      conditions: [{ field: 'cart.subtotal', operator: 'gte', value: 12000 }],
      benefit: { type: 'percentage_discount', value: 5, target: { scope: 'order' } },
    });
    const grande = promo({
      id: 'grande',
      conditions: [{ field: 'cart.subtotal', operator: 'gte', value: 12000 }],
      benefit: { type: 'percentage_discount', value: 40, target: { scope: 'order' } },
    });
    const result = evaluate(
      [line({ productId: HAMBURGUESA, quantity: 2, unitPrice: 5000 })],
      [chico, grande]
    );
    expect(result.unlockable.map((u) => u.promotionId)).toEqual(['grande', 'chico']);
  });
});

describe('evaluatePromotions — vigencia en la timezone del negocio', () => {
  const martes18a20 = dosPorUno({
    validity: { daysOfWeek: [2], timeRange: { from: '18:00', to: '20:00' } },
  });

  it('aplica el martes a las 19:00 hora local', () => {
    expect(isPromotionInValidityWindow(martes18a20, MARTES_19H, TZ)).toBe(true);
  });

  it('no aplica a las 20:03 hora local, aunque sea martes', () => {
    const martes2003 = new Date('2026-09-01T23:03:00.000Z');
    expect(isPromotionInValidityWindow(martes18a20, martes2003, TZ)).toBe(false);
  });

  it('no aplica el miércoles', () => {
    const miercoles = new Date('2026-09-02T22:00:00.000Z');
    expect(isPromotionInValidityWindow(martes18a20, miercoles, TZ)).toBe(false);
  });

  it('usa la timezone del negocio, no la del servidor', () => {
    // 22:00 UTC es martes 19:00 en Buenos Aires pero miércoles 07:00 en Tokio.
    expect(isPromotionInValidityWindow(martes18a20, MARTES_19H, 'Asia/Tokyo')).toBe(false);
  });

  it('respeta startsAt / endsAt', () => {
    const vencida = dosPorUno({
      validity: { endsAt: '2026-08-01T00:00:00.000Z' },
    });
    expect(isPromotionInValidityWindow(vencida, MARTES_19H, TZ)).toBe(false);
  });

  it('una promo fuera de ventana no aplica ni aparece como desbloqueable', () => {
    const result = evaluate([line({ productId: HAMBURGUESA, quantity: 1 })], [
      dosPorUno({ validity: { daysOfWeek: [3] } }),
    ]);
    expect(result.applied).toEqual([]);
    expect(result.unlockable).toEqual([]);
  });
});

describe('evaluatePromotions — condiciones no evaluables y otros campos', () => {
  it('ignora una promo con una condición fuera de la whitelist', () => {
    const result = evaluate(
      [line({ productId: HAMBURGUESA, quantity: 2 })],
      [
        promo({
          conditions: [{ field: 'cart.total_after_discount', operator: 'gte', value: 1 }],
          benefit: { type: 'percentage_discount', value: 50, target: { scope: 'order' } },
        }),
      ]
    );
    expect(result.applied).toEqual([]);
    expect(result.monetaryDiscount).toBe(0);
  });

  it('ignora una promo cuyo producto no está vinculado al menú', () => {
    const sinVinculo = dosPorUno({ menuItemIdByPath: {} });
    const result = evaluate([line({ productId: HAMBURGUESA, quantity: 2 })], [sinVinculo]);
    expect(result.applied).toEqual([]);
  });

  it('cart.itemCount cuenta unidades, no líneas (B1)', () => {
    const result = evaluate(
      [line({ productId: HAMBURGUESA, quantity: 3, unitPrice: 1000 })],
      [
        promo({
          conditions: [{ field: 'cart.itemCount', operator: 'gte', value: 3 }],
          benefit: { type: 'percentage_discount', value: 10, target: { scope: 'order' } },
        }),
      ]
    );
    expect(result.applied).toHaveLength(1);
  });

  it('order.isFirstPurchase se evalúa contra los facts del cliente', () => {
    const primeraCompra = promo({
      conditions: [{ field: 'order.isFirstPurchase', operator: 'eq', value: true }],
      benefit: { type: 'percentage_discount', value: 10, target: { scope: 'order' } },
    });
    const cart = [line({ productId: HAMBURGUESA, quantity: 1 })];

    expect(
      evaluatePromotions({
        cartLines: cart,
        promotions: [primeraCompra],
        customerFacts: { isFirstPurchase: true },
        now: MARTES_19H,
        timezone: TZ,
      }).applied
    ).toHaveLength(1);

    expect(
      evaluatePromotions({
        cartLines: cart,
        promotions: [primeraCompra],
        customerFacts: { isFirstPurchase: false },
        now: MARTES_19H,
        timezone: TZ,
      }).applied
    ).toEqual([]);
  });

  it('cart.subtotal se evalúa PRE-promoción (no se desactiva a sí misma)', () => {
    // 2 × $5.000 = $10.000 ≥ $10.000 con un 50% que dejaría el total en $5.000.
    const result = evaluate(
      [line({ productId: HAMBURGUESA, quantity: 2, unitPrice: 5000 })],
      [
        promo({
          conditions: [{ field: 'cart.subtotal', operator: 'gte', value: 10000 }],
          benefit: { type: 'percentage_discount', value: 50, target: { scope: 'order' } },
        }),
      ]
    );
    expect(result.applied).toHaveLength(1);
    expect(result.monetaryDiscount).toBe(5000);
  });
});
