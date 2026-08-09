/**
 * Test de get_payment_methods (Tarea 1.4 de PLAN-ACCION-CALIDAD-CONVERSACIONAL.md).
 *
 * Cubre D4: la tool debe responder preguntas de pago SIN depender de que
 * haya carrito activo — con draft, los ajustes traen el monto real; sin
 * draft, la regla configurada (tipo/valor) sin monto final.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: {
      findFirst: vi.fn(),
    },
    payment_method_config: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../../services/businessConfig.service', () => ({
  getBusinessConfig: vi.fn(),
}));

vi.mock('../../services/paymentMethods.service', () => ({
  listOfferedPaymentMethods: vi.fn(),
}));

vi.mock('../../services/paymentAdjustment.service', () => ({
  listPaymentAdjustmentsForAmount: vi.fn(),
}));

vi.mock('../../services/menu.service', () => ({
  MenuService: {},
}));

import { getPaymentMethodsTool } from '../index';
import { prisma } from '../../lib/prisma';
import { getBusinessConfig } from '../../services/businessConfig.service';
import { listOfferedPaymentMethods } from '../../services/paymentMethods.service';
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

const OFFERED = [
  { id: 'cash', label: 'Efectivo' },
  { id: 'transfer', label: 'Transferencia' },
];

const callTool = () => getPaymentMethodsTool.func({}, undefined, CONFIG);

describe('get_payment_methods', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBusinessConfig).mockResolvedValue({
      external_delivery_enabled: false,
    } as never);
    vi.mocked(listOfferedPaymentMethods).mockResolvedValue(OFFERED as never);
  });

  it('sin draft activo: devuelve métodos y la regla configurada, sin monto final', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.payment_method_config.findMany).mockResolvedValue([
      {
        payment_method: 'cash',
        label: 'Descuento por efectivo',
        adjustment_type: 'PERCENT',
        adjustment_value: 10,
        is_surcharge: false,
      },
    ] as never);

    const result = JSON.parse((await callTool()) as string);

    expect(result.methods).toEqual(OFFERED.map((m) => ({ id: m.id, label: m.label })));
    expect(result.adjustments).toEqual([
      {
        method: 'cash',
        label: 'Descuento por efectivo',
        type: 'PERCENT',
        value: 10,
        isSurcharge: false,
      },
    ]);
    expect(result.note).toContain('no hay carrito activo');
  });

  it('sin draft y sin ajustes configurados: adjustments vacío y note null', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.payment_method_config.findMany).mockResolvedValue([] as never);

    const result = JSON.parse((await callTool()) as string);
    expect(result.adjustments).toEqual([]);
    expect(result.note).toBeNull();
  });

  it('con draft activo con ítems: los ajustes traen el monto real calculado', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      id: 'draft-1',
      draft_order_item: [
        {
          list_price: null,
          discount_amount: null,
          unit_price: { toNumber: () => 3500 } as never,
          total_price: { toNumber: () => 3500 } as never,
          quantity: 1,
        },
      ],
    } as never);
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
    expect(result.adjustments).toEqual([
      {
        method: 'cash',
        label: 'Descuento por efectivo',
        adjustment: '-350.00',
        finalAmount: '3150.00',
        isSurcharge: false,
      },
    ]);
    expect(result.note).toBeNull();
  });
});
