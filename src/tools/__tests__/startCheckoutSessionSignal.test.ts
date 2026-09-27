/**
 * start_checkout_session es una señal. No lee el draft dentro del ToolNode.
 * assertCanOrder y el horario siguen adentro: no compiten con un add del batch.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: { findFirst: vi.fn() },
    business: { findUnique: vi.fn() },
  },
}));

vi.mock('../../services/ordersCapabilityGate.service', () => ({
  assertCanOrder: vi.fn(),
}));

vi.mock('../../services/businessHours.service', () => ({
  getBusinessOpenInfo: vi.fn(),
}));

vi.mock('../../services/businessConfig.service', () => ({
  getBusinessConfig: vi.fn(),
}));

import { startCheckoutSessionTool } from '../checkout';
import { prisma } from '../../lib/prisma';
import { assertCanOrder } from '../../services/ordersCapabilityGate.service';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

describe('start_checkout_session', () => {
  beforeEach(() => {
    vi.mocked(assertCanOrder).mockResolvedValue({ ok: true });
    vi.mocked(prisma.business.findUnique).mockResolvedValue(null);
  });

  it('devuelve la señal sin consultar el carrito', async () => {
    const raw = await startCheckoutSessionTool.func(
      { reason: 'el cliente quiere pagar' },
      undefined,
      CONFIG
    );
    expect(JSON.parse(raw as string)).toEqual({
      signal: 'start_checkout_session',
      reason: 'el cliente quiere pagar',
    });
    expect(prisma.draft_order.findFirst).not.toHaveBeenCalled();
    expect(raw).not.toContain('empty_cart');
  });

  it('si assertCanOrder falla, conserva el mensaje y no lee el draft', async () => {
    vi.mocked(assertCanOrder).mockResolvedValue({
      ok: false,
      error: 'orders_disabled',
      message: 'Los pedidos están deshabilitados.',
    });
    const raw = await startCheckoutSessionTool.func(
      { reason: 'cerrar' },
      undefined,
      CONFIG
    );
    const parsed = JSON.parse(raw as string) as { instruction?: string; error?: string };
    expect(parsed.error).toBe('orders_disabled');
    expect(parsed.instruction).toMatch(/NO VUELVAS a llamar a start_checkout_session/);
    expect(prisma.draft_order.findFirst).not.toHaveBeenCalled();
  });
});
