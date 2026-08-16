import { describe, expect, it } from 'vitest';
import {
  buildPromotionDisplay,
  buildSummaryLine,
  formatBenefitLabel,
  formatConditionLabel,
} from '../buildPromotionDisplay';

describe('formatConditionLabel', () => {
  it('no expone JSON crudo para cart.product', () => {
    const label = formatConditionLabel({
      field: 'cart.product',
      operator: 'gte',
      value: { productName: 'hamburguesa', quantity: 1 },
    });
    expect(label).toBe('Si compra hamburguesa');
    expect(label).not.toContain('{');
    expect(label).not.toContain('cart.product');
  });

  it('formatea cantidad > 1', () => {
    expect(
      formatConditionLabel({
        field: 'cart.product',
        operator: 'gte',
        value: { productName: 'hamburguesa', quantity: 2 },
      })
    ).toBe('Si compra al menos 2 × hamburguesa');
  });

  it('formatea subtotal', () => {
    expect(
      formatConditionLabel({
        field: 'cart.subtotal',
        operator: 'gt',
        value: 40000,
      })
    ).toBe('En pedidos de más de $40.000');
  });
});

describe('formatBenefitLabel', () => {
  it('producto gratis', () => {
    expect(
      formatBenefitLabel({
        type: 'free_product',
        productName: 'papas fritas',
        quantity: 1,
      })
    ).toBe('Regalo: papas fritas');
  });
});

describe('buildPromotionDisplay', () => {
  it('arma conditions legibles y entityCards con thumbnail null', () => {
    const display = buildPromotionDisplay({
      status: 'complete',
      offer: {
        name: 'Martes de hamburguesas',
        conditions: [
          {
            field: 'cart.product',
            operator: 'gte',
            value: { productName: 'hamburguesa', quantity: 1 },
          },
        ],
        benefit: {
          type: 'free_product',
          productName: 'papas fritas',
          quantity: 1,
        },
        validity: {
          daysOfWeek: [2],
          timeRange: { from: '18:00', to: '20:00' },
        },
        stacking: { allowed: false },
      },
      unresolvedEntities: [
        {
          type: 'product',
          text: 'hamburguesa',
          path: 'offer.conditions[0].value.productName',
        },
        {
          type: 'product',
          text: 'papas fritas',
          path: 'offer.benefit.productName',
        },
      ],
    });

    expect(display.statusLabel).toBe('Borrador usable');
    expect(display.benefitLabel).toBe('Regalo: papas fritas');
    expect(display.conditions[0]?.label).toBe('Si compra hamburguesa');
    expect(display.validityLines).toEqual([
      'Días: Martes',
      'Horario: 18:00 a 20:00',
    ]);
    expect(display.stackingLabel).toBe('No se combina con otras promos');
    expect(display.entityCards).toEqual([
      {
        name: 'Hamburguesa',
        kind: 'product',
        icon: 'utensils',
        productId: null,
        thumbnailUrl: null,
        resolved: false,
        path: 'offer.conditions[0].value.productName',
        subtitle: 'Pendiente de vincular al menú',
        candidates: [],
      },
      {
        name: 'Papas Fritas',
        kind: 'product',
        icon: 'utensils',
        productId: null,
        thumbnailUrl: null,
        resolved: false,
        path: 'offer.benefit.productName',
        subtitle: 'Pendiente de vincular al menú',
        candidates: [],
      },
    ]);
  });

  it('preselecciona el platillo cuando la resolución fue exacta y única', () => {
    const display = buildPromotionDisplay({
      status: 'complete',
      offer: {
        name: 'Promo',
        conditions: [],
        benefit: { type: 'free_product', productName: 'papas fritas', quantity: 1 },
      },
      unresolvedEntities: [
        { type: 'product', text: 'papas fritas', path: 'offer.benefit.productName' },
      ],
      resolutions: [
        {
          path: 'offer.benefit.productName',
          resolved: true,
          candidates: [
            {
              menuItemId: 'item-1',
              name: 'Papas rústicas',
              thumbnailUrl: 'https://cdn/papas.jpg',
              price: 4500,
              currencyCode: 'ARS',
              score: 1,
              source: 'exact',
              matchedVariation: null,
            },
          ],
        },
      ],
    });

    expect(display.entityCards[0]).toMatchObject({
      productId: 'item-1',
      thumbnailUrl: 'https://cdn/papas.jpg',
      resolved: true,
      subtitle: 'Vinculado al menú',
    });
  });

  it('pide elegir cuando hay varios candidatos', () => {
    const display = buildPromotionDisplay({
      status: 'complete',
      offer: {
        name: 'Promo',
        conditions: [],
        benefit: { type: 'free_product', productName: 'papas', quantity: 1 },
      },
      unresolvedEntities: [
        { type: 'product', text: 'papas', path: 'offer.benefit.productName' },
      ],
      resolutions: [
        {
          path: 'offer.benefit.productName',
          resolved: false,
          candidates: [
            {
              menuItemId: 'a',
              name: 'Papas rústicas',
              thumbnailUrl: null,
              price: null,
              currencyCode: null,
              score: 0.7,
              source: 'contains',
              matchedVariation: null,
            },
            {
              menuItemId: 'b',
              name: 'Papas fritas',
              thumbnailUrl: null,
              price: null,
              currencyCode: null,
              score: 0.65,
              source: 'contains',
              matchedVariation: null,
            },
          ],
        },
      ],
    });

    expect(display.entityCards[0]).toMatchObject({
      productId: null,
      resolved: false,
      subtitle: 'Elegí el platillo del menú',
    });
    expect(display.entityCards[0]?.candidates).toHaveLength(2);
  });

  it('avisa cuando el platillo no está en el menú', () => {
    const display = buildPromotionDisplay({
      status: 'complete',
      offer: {
        name: 'Promo',
        conditions: [],
        benefit: { type: 'free_product', productName: 'sushi', quantity: 1 },
      },
      unresolvedEntities: [
        { type: 'product', text: 'sushi', path: 'offer.benefit.productName' },
      ],
      resolutions: [
        { path: 'offer.benefit.productName', resolved: false, candidates: [] },
      ],
    });

    expect(display.entityCards[0]?.subtitle).toBe(
      'No encontramos este platillo en el menú'
    );
  });
});

describe('buildSummaryLine', () => {
  it('arma una línea con beneficio, días y horario', () => {
    expect(
      buildSummaryLine({
        name: 'Promo',
        conditions: [],
        benefit: { type: 'percentage_discount', value: 20 },
        validity: { daysOfWeek: [1, 2], timeRange: { from: '18:00', to: '20:00' } },
      })
    ).toBe('20% de descuento · Lunes, Martes · 18:00 a 20:00');
  });

  it('omite las partes ausentes', () => {
    expect(
      buildSummaryLine({
        name: 'Promo',
        conditions: [],
        benefit: { type: 'free_shipping' },
      })
    ).toBe('Envío gratis');
  });
});
