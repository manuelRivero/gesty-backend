/**
 * Frontera entre cancelar la cola y cancelar el pedido.
 *
 * `clear_pending_order_lines` solo descarta lo que falta sumar: el carrito
 * sobrevive, y la observación tiene que decirlo para que el bot no conteste
 * "cancelé el pedido" con ítems adentro (evidencia: conversación del 20/8,
 * "Cancelar pedido" → cola vacía + 2 papas en el carrito).
 * El reset total es `cancel_order` → `clearOrderSessionAfterCancel`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: { findFirst: vi.fn() },
  },
}));

vi.mock('../../services/menu.service', () => ({ MenuService: {} }));

const clearPendingOrderLines = vi.fn();

vi.mock('../../services/pendingOrderLines.service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../services/pendingOrderLines.service')>();
  return {
    ...actual,
    clearPendingOrderLines: (...args: unknown[]) => clearPendingOrderLines(...args),
  };
});

import { prisma } from '../../lib/prisma';
import { clearPendingOrderLinesTool } from '../index';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

const callTool = () => clearPendingOrderLinesTool.func({}, undefined, CONFIG);

describe('clear_pending_order_lines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('con carrito lleno avisa que el carrito sigue y ofrece cancel_order', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      draft_order_item: [{ quantity: 2 }, { quantity: 1 }],
    } as never);

    const result = JSON.parse((await callTool()) as string);

    expect(clearPendingOrderLines).toHaveBeenCalledWith('conv-1');
    expect(result.cleared).toBe(true);
    expect(result.cartItemCount).toBe(2);
    expect(result.instruction).toMatch(/carrito sigue/i);
    expect(result.instruction).toMatch(/cancel_order/);
  });

  it('sin draft activo no promete un carrito que no existe', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(null as never);

    const result = JSON.parse((await callTool()) as string);

    expect(result.cartItemCount).toBe(0);
    expect(result.instruction).toMatch(/no tiene ítems/i);
    expect(result.instruction).not.toMatch(/cancel_order/);
  });
});
