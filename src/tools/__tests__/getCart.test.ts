/**
 * Test de get_cart: expone el costo real de envío (solo cuando ya es
 * resoluble, es decir hay dirección guardada en cobertura) y los ajustes
 * reales por método de pago, en vez de dejar que el modelo derive o invente
 * una respuesta a "¿cuánto cuesta el envío?" / "¿hay descuento en efectivo?".
 *
 * Hallazgo real (prueba manual contra el bot): el agente de checkout
 * respondía con una frase genérica ("se calcula al finalizar") aunque
 * `paymentOptions` ya tenía el número real, y nunca exponía el delivery fee
 * real ni siquiera con la dirección ya guardada.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('../../services/deliveryFee.service', () => ({
  resolveDeliveryContext: vi.fn(),
}));

vi.mock('../../services/paymentAdjustment.service', () => ({
  listPaymentAdjustmentsForAmount: vi.fn(),
}));

vi.mock('../../services/menu.service', () => ({
  MenuService: {},
}));

import { getCartTool } from '../index';
import { prisma } from '../../lib/prisma';
import { resolveDeliveryContext } from '../../services/deliveryFee.service';
import { listPaymentAdjustmentsForAmount } from '../../services/paymentAdjustment.service';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

const ITEM = {
  id: 'line-1',
  product_id: 'prod-1',
  menu_item: { id: 'prod-1', name: 'Ceviche' },
  quantity: 1,
  unit_price: { toString: () => '3500', toNumber: () => 3500 } as never,
  total_price: { toString: () => '3500', toNumber: () => 3500 } as never,
  notes: null,
  list_price: null,
  discount_amount: null,
};

const draft = (overrides: Partial<{ fulfillment_type: string | null }> = {}) => ({
  id: 'draft-1',
  expires_at: null,
  fulfillment_type: null,
  draft_order_item: [ITEM],
  ...overrides,
});

const callTool = () => getCartTool.func({}, undefined, CONFIG);

describe('get_cart — costo real de envío y ajustes por método de pago', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listPaymentAdjustmentsForAmount).mockResolvedValue([]);
    vi.mocked(resolveDeliveryContext).mockResolvedValue({
      deliveryFee: 0,
      minOrderAmount: 0,
      zoneName: null,
      zoneId: null,
      estimatedMinutes: null,
    });
  });

  it('no hay draft → exists: false', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(null as never);
    const result = JSON.parse((await callTool()) as string);
    expect(result).toEqual({ exists: false, items: [] });
  });

  it('TAKE_AWAY → deliveryFee y note en null (no aplica)', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(
      draft({ fulfillment_type: 'TAKE_AWAY' }) as never
    );
    const result = JSON.parse((await callTool()) as string);
    expect(result.pricing.deliveryFee).toBeNull();
    expect(result.pricing.total).toBeNull();
    expect(result.pricing.note).toBeNull();
  });

  it('DELIVERY sin dirección en cobertura → deliveryFee null, con nota explicativa', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(
      draft({ fulfillment_type: 'DELIVERY' }) as never
    );
    vi.mocked(resolveDeliveryContext).mockResolvedValue({
      deliveryFee: 0,
      minOrderAmount: 0,
      zoneName: null,
      zoneId: null, // sin zona resuelta = sin dirección todavía
      estimatedMinutes: null,
    });

    const result = JSON.parse((await callTool()) as string);
    expect(result.pricing.deliveryFee).toBeNull();
    expect(result.pricing.total).toBeNull();
    expect(result.pricing.note).toContain('zona');
  });

  it('DELIVERY con dirección en cobertura → deliveryFee real y total con envío incluido', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(
      draft({ fulfillment_type: 'DELIVERY' }) as never
    );
    vi.mocked(resolveDeliveryContext).mockResolvedValue({
      deliveryFee: 800,
      minOrderAmount: 0,
      zoneName: 'Centro',
      zoneId: 'zone-1',
      estimatedMinutes: 30,
    });

    const result = JSON.parse((await callTool()) as string);
    expect(result.pricing.deliveryFee).toBe('800.00');
    expect(result.pricing.itemsTotal).toBe('3500.00');
    expect(result.pricing.total).toBe('4300.00');
    expect(result.pricing.note).toBeNull();
  });

  it('expone paymentOptions reales cuando el negocio tiene ajustes configurados', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(draft() as never);
    vi.mocked(listPaymentAdjustmentsForAmount).mockResolvedValue([
      {
        paymentMethod: 'cash',
        label: 'Descuento por efectivo',
        adjustmentAmount: -350,
        finalAmount: 3150,
        isSurcharge: false,
      },
    ]);

    const result = JSON.parse((await callTool()) as string);
    expect(result.paymentOptions).toEqual([
      {
        method: 'cash',
        label: 'Descuento por efectivo',
        adjustment: '-350.00',
        finalAmount: '3150.00',
        isSurcharge: false,
      },
    ]);
  });

  it('paymentOptions es null cuando el negocio no tiene ajustes configurados', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(draft() as never);
    const result = JSON.parse((await callTool()) as string);
    expect(result.paymentOptions).toBeNull();
  });
});
