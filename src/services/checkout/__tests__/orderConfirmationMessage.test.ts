/**
 * Test del resumen de confirmación final del pedido (paso `confirm` del
 * checkout). Verifica que el total mostrado incluye envío real y el ajuste
 * del método de pago elegido — el mismo cálculo que se usa para cobrar de
 * verdad al confirmar (`checkout.service.ts`), no una copia aparte.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    draft_order: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('../../deliveryFee.service', () => ({
  resolveDeliveryContext: vi.fn(),
}));

vi.mock('../../paymentAdjustment.service', () => ({
  resolvePaymentAdjustment: vi.fn(),
}));

import { buildOrderConfirmationMessage } from '../orderConfirmationMessage';
import { prisma } from '../../../lib/prisma';
import { resolveDeliveryContext } from '../../deliveryFee.service';
import { resolvePaymentAdjustment } from '../../paymentAdjustment.service';

const ITEM = {
  id: 'line-1',
  quantity: 1,
  unit_price: { toNumber: () => 3500 } as never,
  list_price: null,
  discount_amount: null,
  menu_item: { name: 'Ceviche' },
};

const draft = (overrides: Partial<{ fulfillment_type: string | null }> = {}) => ({
  id: 'draft-1',
  fulfillment_type: null,
  draft_order_item: [ITEM],
  ...overrides,
});

const NO_DELIVERY = {
  deliveryFee: 0,
  minOrderAmount: 0,
  zoneName: null,
  zoneId: null,
  estimatedMinutes: null,
};

const NO_ADJUSTMENT = { adjustmentAmount: 0, label: null, hasAdjustment: false };

const params = (overrides: Partial<{ paymentMethod: 'cash' | 'online' }> = {}) => ({
  businessId: 'biz-1',
  customerId: 'cust-1',
  customerPhone: '+5491100000000',
  paymentMethod: 'cash' as const,
  currencyCode: 'ARS',
  ...overrides,
});

describe('buildOrderConfirmationMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveDeliveryContext).mockResolvedValue(NO_DELIVERY);
    vi.mocked(resolvePaymentAdjustment).mockResolvedValue(NO_ADJUSTMENT);
  });

  it('null si no hay carrito activo', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(null as never);
    const result = await buildOrderConfirmationMessage(params());
    expect(result).toBeNull();
  });

  it('incluye botones de confirmar y cancelar', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(draft() as never);
    const result = await buildOrderConfirmationMessage(params());
    const buttons = result!.interactive.action!.buttons!.map((b) => b.reply.id);
    expect(buttons).toEqual(['CONFIRM_ORDER', 'EDIT_PAYMENT_METHOD']);
  });

  it('el total incluye el envío real cuando hay dirección en cobertura', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(
      draft({ fulfillment_type: 'DELIVERY' }) as never
    );
    vi.mocked(resolveDeliveryContext).mockResolvedValue({
      ...NO_DELIVERY,
      deliveryFee: 800,
      zoneId: 'zone-1',
    });

    const result = await buildOrderConfirmationMessage(params());
    const body = result!.interactive.body!.text;
    expect(body).toContain('800.00');
    expect(body).toContain('4300.00'); // 3500 + 800
  });

  it('el total incluye el ajuste real del método de pago elegido', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(draft() as never);
    vi.mocked(resolvePaymentAdjustment).mockResolvedValue({
      adjustmentAmount: -350,
      label: 'Descuento por efectivo',
      hasAdjustment: true,
    });

    const result = await buildOrderConfirmationMessage(params({ paymentMethod: 'cash' }));
    const body = result!.interactive.body!.text;
    expect(body).toContain('Descuento por efectivo');
    expect(body).toContain('3150.00'); // 3500 - 350
  });

  it('antepone leadingText cuando se retoma tras una interrupción', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(draft() as never);
    const result = await buildOrderConfirmationMessage({
      ...params(),
      leadingText: 'Sí, aceptamos Mercado Pago.',
    });
    expect(result!.interactive.body!.text.startsWith('Sí, aceptamos Mercado Pago.')).toBe(true);
  });
});
