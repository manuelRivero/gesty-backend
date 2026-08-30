/**
 * Tests del PromotionInterpreter V1.
 * El LLM se mockea; se valida que la estructura represente la intención
 * y que la validación/backend post-procese correctamente.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
}));

vi.mock('../../../config/llm', () => ({
  getIntentDetectorLlm: vi.fn(() => ({
    withStructuredOutput: () => ({ invoke: mockInvoke }),
    invoke: mockInvoke,
  })),
}));

import { interpretPromotionText } from '../promotionInterpreter.service';
import { PromotionInterpreterLlmSchema } from '../promotionInterpreter.schemas';
import type { PromotionInterpreterLlmOutput } from '../promotionInterpreter.schemas';

function llmOk(partial: PromotionInterpreterLlmOutput) {
  mockInvoke.mockResolvedValueOnce(partial);
}

describe('promotionInterpreter.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. descuento porcentual', async () => {
    llmOk({
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
        benefit: { type: 'percentage_discount', value: 20, target: { scope: 'order' } },
        validity: { daysOfWeek: [2] },
      },
      missingInformation: [],
      unresolvedEntities: [
        {
          type: 'product',
          text: 'hamburguesa',
          path: 'offer.conditions[0].value.productName',
        },
      ],
    });

    const result = await interpretPromotionText({
      text: 'Los martes, 20% de descuento en hamburguesas.',
    });

    expect(result.status).toBe('complete');
    if (result.status === 'error') return;
    expect(result.offer.benefit).toEqual({
      type: 'percentage_discount',
      value: 20,
      target: { scope: 'order' },
    });
    expect(result.offer.validity?.daysOfWeek).toEqual([2]);
    expect(result.unresolvedEntities.some((e) => e.text === 'hamburguesa')).toBe(true);
  });

  it('2. descuento fijo', async () => {
    llmOk({
      status: 'complete',
      offer: {
        name: 'Descuento por monto',
        conditions: [{ field: 'cart.subtotal', operator: 'gt', value: 30000 }],
        benefit: { type: 'fixed_discount', value: 5000, target: { scope: 'order' } },
      },
      missingInformation: [],
      unresolvedEntities: [],
    });

    const result = await interpretPromotionText({
      text: 'Gastando más de $30.000 tienes $5.000 de descuento.',
    });

    expect(result.status).toBe('complete');
    if (result.status === 'error') return;
    expect(result.offer.benefit).toEqual({
      type: 'fixed_discount',
      value: 5000,
      target: { scope: 'order' },
    });
    expect(result.offer.conditions[0]).toMatchObject({
      field: 'cart.subtotal',
      operator: 'gt',
      value: 30000,
    });
  });

  it('3. precio fijo', async () => {
    llmOk({
      status: 'complete',
      offer: {
        name: 'Pizza a precio fijo',
        conditions: [
          {
            field: 'cart.product',
            operator: 'gte',
            value: { productName: 'pizza muzzarella', quantity: 1 },
          },
        ],
        benefit: {
          type: 'fixed_price',
          value: 8000,
          target: { scope: 'product', productName: 'pizza muzzarella' },
        },
      },
      missingInformation: [],
      unresolvedEntities: [
        {
          type: 'product',
          text: 'pizza muzzarella',
          path: 'offer.conditions[0].value.productName',
        },
      ],
    });

    const result = await interpretPromotionText({
      text: 'La pizza muzzarella a $8000.',
    });

    expect(result.status).toBe('complete');
    if (result.status === 'error') return;
    expect(result.offer.benefit).toEqual({
      type: 'fixed_price',
      value: 8000,
      target: { scope: 'product', productName: 'pizza muzzarella' },
    });
  });

  it('4. producto gratis', async () => {
    llmOk({
      status: 'complete',
      offer: {
        name: 'Hamburguesa con papas',
        conditions: [
          {
            field: 'cart.product',
            operator: 'gte',
            value: { productName: 'hamburguesa', quantity: 1 },
          },
        ],
        benefit: { type: 'free_product', productName: 'papas', quantity: 1 },
      },
      missingInformation: [],
      unresolvedEntities: [],
    });

    const result = await interpretPromotionText({
      text: 'Si compras una hamburguesa te regalamos papas.',
    });

    expect(result.status).toBe('complete');
    if (result.status === 'error') return;
    expect(result.offer.benefit).toEqual({
      type: 'free_product',
      productName: 'papas',
      quantity: 1,
    });
    // Backend deriva unresolved si el LLM las omitió
    expect(result.unresolvedEntities.map((e) => e.text).sort()).toEqual(
      ['hamburguesa', 'papas'].sort()
    );
  });

  it('5. condición por cantidad', async () => {
    llmOk({
      status: 'complete',
      offer: {
        name: '3 empanadas + 1',
        conditions: [
          {
            field: 'cart.product',
            operator: 'gte',
            value: { productName: 'empanada', quantity: 3 },
          },
        ],
        benefit: { type: 'free_product', productName: 'empanada', quantity: 1 },
        validity: { daysOfWeek: [5] },
      },
      missingInformation: [],
      unresolvedEntities: [
        {
          type: 'product',
          text: 'empanada',
          path: 'offer.conditions[0].value.productName',
        },
      ],
    });

    const result = await interpretPromotionText({
      text: 'Los viernes, llevando 3 empanadas, te regalamos una.',
    });

    expect(result.status).toBe('complete');
    if (result.status === 'error') return;
    expect(result.offer.conditions[0]?.value).toMatchObject({
      productName: 'empanada',
      quantity: 3,
    });
  });

  it('6. condición por importe', async () => {
    llmOk({
      status: 'complete',
      offer: {
        name: 'Envío gratis',
        conditions: [{ field: 'cart.subtotal', operator: 'gt', value: 40000 }],
        benefit: { type: 'free_shipping' },
      },
      missingInformation: [],
      unresolvedEntities: [],
    });

    const result = await interpretPromotionText({
      text: 'En pedidos superiores a $40.000 el envío es gratis.',
    });

    expect(result.status).toBe('complete');
    if (result.status === 'error') return;
    expect(result.offer.benefit).toEqual({ type: 'free_shipping' });
    expect(result.offer.conditions[0]?.value).toBe(40000);
  });

  it('7. día de la semana', async () => {
    llmOk({
      status: 'complete',
      offer: {
        name: 'Promo martes',
        conditions: [],
        benefit: { type: 'percentage_discount', value: 10, target: { scope: 'order' } },
        validity: { daysOfWeek: [2] },
      },
      missingInformation: [],
      unresolvedEntities: [],
    });

    const result = await interpretPromotionText({ text: 'Los martes 10% off.' });
    expect(result.status).toBe('complete');
    if (result.status === 'error') return;
    expect(result.offer.validity?.daysOfWeek).toEqual([2]);
  });

  it('8. rango horario', async () => {
    llmOk({
      status: 'complete',
      offer: {
        name: 'Happy hour pizza',
        conditions: [
          {
            field: 'cart.product',
            operator: 'gte',
            value: { productName: 'pizza', quantity: 2 },
          },
        ],
        benefit: {
          type: 'percentage_discount',
          value: 50,
          target: { scope: 'product', productName: 'pizza', units: 1 },
        },
        validity: {
          daysOfWeek: [1, 2, 3, 4],
          timeRange: { from: '18:00', to: '20:00' },
        },
      },
      missingInformation: [],
      unresolvedEntities: [
        {
          type: 'product',
          text: 'pizza',
          path: 'offer.conditions[0].value.productName',
        },
      ],
    });

    const result = await interpretPromotionText({
      text: 'De lunes a jueves de 18 a 20 horas, la segunda pizza tiene 50% de descuento.',
    });

    expect(result.status).toBe('complete');
    if (result.status === 'error') return;
    expect(result.offer.validity?.timeRange).toEqual({ from: '18:00', to: '20:00' });
    expect(result.offer.validity?.daysOfWeek).toEqual([1, 2, 3, 4]);
  });

  it('9. fecha de inicio/fin', async () => {
    llmOk({
      status: 'complete',
      offer: {
        name: 'Agosto nocturno',
        conditions: [],
        benefit: { type: 'fixed_discount', value: 3000, target: { scope: 'order' } },
        validity: {
          startsAt: '2026-08-01',
          endsAt: '2026-08-31',
          timeRange: { from: '22:00', to: '23:59' },
        },
      },
      missingInformation: [],
      unresolvedEntities: [],
    });

    const result = await interpretPromotionText({
      text: 'Durante agosto, todos los pedidos después de las 22 tienen $3.000 de descuento.',
    });

    expect(result.status).toBe('complete');
    if (result.status === 'error') return;
    expect(result.offer.validity?.startsAt).toBe('2026-08-01');
    expect(result.offer.validity?.endsAt).toBe('2026-08-31');
    expect(result.offer.validity?.timeRange?.from).toBe('22:00');
  });

  it('10. información incompleta', async () => {
    llmOk({
      status: 'needs_clarification',
      offer: {
        name: 'Promo hamburguesas',
        conditions: [
          {
            field: 'cart.product',
            operator: 'contains',
            value: { productName: 'hamburguesa' },
          },
        ],
        benefit: null,
      },
      missingInformation: [
        { field: 'benefit', question: '¿Qué beneficio quieres ofrecer?' },
      ],
      unresolvedEntities: [
        {
          type: 'product',
          text: 'hamburguesa',
          path: 'offer.conditions[0].value.productName',
        },
      ],
    });

    const result = await interpretPromotionText({
      text: 'Quiero hacer una promoción para hamburguesas.',
    });

    expect(result.status).toBe('needs_clarification');
    if (result.status === 'error') return;
    expect(result.missingInformation.some((m) => m.field === 'benefit')).toBe(true);
    expect(result.offer.benefit == null).toBe(true);
  });

  it('11. múltiples condiciones', async () => {
    llmOk({
      status: 'needs_clarification',
      offer: {
        name: 'Martes de hamburguesas',
        conditions: [
          {
            field: 'cart.product',
            operator: 'gte',
            value: { productName: 'hamburguesa', quantity: 2 },
          },
        ],
        benefit: { type: 'free_product', productName: 'papas', quantity: 1 },
        validity: {
          daysOfWeek: [2],
          timeRange: { from: '18:00', to: '20:00' },
        },
      },
      missingInformation: [],
      unresolvedEntities: [
        {
          type: 'product',
          text: 'hamburguesa',
          path: 'offer.conditions[0].value.productName',
        },
        {
          type: 'product',
          text: 'papas',
          path: 'offer.benefit.productName',
        },
      ],
    });

    const result = await interpretPromotionText({
      text: 'Los martes, de 18 a 20, si alguien compra dos hamburguesas le regalamos papas.',
    });

    expect(result.status).toBe('needs_clarification');
    if (result.status === 'error') return;
    expect(result.offer.conditions).toHaveLength(1);
    expect(result.offer.benefit).toMatchObject({ type: 'free_product', productName: 'papas' });
    expect(result.offer.validity).toMatchObject({
      daysOfWeek: [2],
      timeRange: { from: '18:00', to: '20:00' },
    });
    expect(result.unresolvedEntities).toHaveLength(2);
  });

  it('12. entidades ambiguas (productos sin resolver)', async () => {
    llmOk({
      status: 'complete',
      offer: {
        name: '2x1 combo',
        conditions: [
          {
            field: 'cart.product',
            operator: 'gte',
            value: { productName: 'combo especial', quantity: 1 },
          },
        ],
        benefit: {
          type: 'percentage_discount',
          value: 50,
          target: { scope: 'product', productName: 'pizza', units: 1 },
        },
      },
      missingInformation: [],
      unresolvedEntities: [
        {
          type: 'product',
          text: 'combo especial',
          path: 'offer.conditions[0].value.productName',
        },
      ],
    });

    const result = await interpretPromotionText({
      text: 'El combo especial con 50% de descuento.',
    });

    expect(result.status).toBe('complete');
    if (result.status === 'error') return;
    expect(result.unresolvedEntities[0]?.text).toBe('combo especial');
    expect(result.unresolvedEntities[0]?.type).toBe('product');
  });

  it('fuerza missing benefit si el LLM omite beneficio y missingInformation', async () => {
    llmOk({
      status: 'complete',
      offer: {
        name: 'Sin beneficio',
        conditions: [],
        benefit: null,
      },
      missingInformation: [],
      unresolvedEntities: [],
    });

    const result = await interpretPromotionText({ text: 'Una promo cualquiera.' });
    expect(result.status).toBe('needs_clarification');
    if (result.status === 'error') return;
    expect(result.missingInformation[0]?.field).toBe('benefit');
  });

  it('devuelve error si el texto está vacío', async () => {
    const result = await interpretPromotionText({ text: '   ' });
    expect(result).toMatchObject({ status: 'error', code: 'EMPTY_INPUT' });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('devuelve error si el LLM falla', async () => {
    mockInvoke.mockRejectedValue(new Error('timeout'));
    const result = await interpretPromotionText({ text: '20% off' });
    expect(result).toMatchObject({ status: 'error', code: 'LLM_FAILED' });
  });

  it('recupera cuando withStructuredOutput falla con JSON aplanado (caso admin real)', async () => {
    const flat = {
      name: 'Martes de hamburguesas con papas fritas gratis',
      status: 'complete',
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
      daysOfWeek: [2],
      timeRange: { from: '18:00', to: '20:00' },
      unresolvedEntities: [],
    };

    const parseError = Object.assign(
      new Error(
        `Failed to parse. Text: ${JSON.stringify(JSON.stringify(flat))}. Error: [{"path":["offer"]}]`
      ),
      { llmOutput: JSON.stringify(flat) }
    );
    mockInvoke.mockRejectedValueOnce(parseError);

    const result = await interpretPromotionText({
      text: 'Los martes de 18 a 20, hamburguesa con papas fritas gratis.',
    });

    expect(result.status).toBe('complete');
    if (result.status === 'error') return;
    expect(result.offer.benefit).toEqual({
      type: 'free_product',
      productName: 'papas fritas',
      quantity: 1,
    });
    expect(result.offer.validity).toEqual({
      daysOfWeek: [2],
      timeRange: { from: '18:00', to: '20:00' },
    });
    expect(result.unresolvedEntities.map((e) => e.text).sort()).toEqual(
      ['hamburguesa', 'papas fritas'].sort()
    );
  });

  it('devuelve error si la validación Zod falla', async () => {
    mockInvoke.mockResolvedValueOnce({
      status: 'complete',
      offer: { name: '', conditions: [], benefit: { type: 'percentage_discount', value: 20 } },
      missingInformation: [],
      unresolvedEntities: [],
    });

    const result = await interpretPromotionText({ text: '20% off' });
    expect(result).toMatchObject({ status: 'error', code: 'VALIDATION_FAILED' });
  });

  it('el schema acepta el caso de éxito del criterio de aceptación', () => {
    const payload = {
      status: 'needs_clarification',
      offer: {
        name: 'Martes de hamburguesas',
        conditions: [
          {
            field: 'cart.product',
            operator: 'gte',
            value: { productName: 'hamburguesa', quantity: 2 },
          },
        ],
        benefit: { type: 'free_product', productName: 'papas', quantity: 1 },
        validity: {
          daysOfWeek: [2],
          timeRange: { from: '18:00', to: '20:00' },
        },
      },
      missingInformation: [],
      unresolvedEntities: [
        {
          type: 'product',
          text: 'hamburguesa',
          path: 'offer.conditions[0].value.productName',
        },
        {
          type: 'product',
          text: 'papas',
          path: 'offer.benefit.productName',
        },
      ],
    };

    const parsed = PromotionInterpreterLlmSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });
});
