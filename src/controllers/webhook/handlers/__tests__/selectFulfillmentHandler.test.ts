import { beforeEach, describe, expect, it, vi } from 'vitest';

const { applyFulfillmentSelectionIfPendingMock } = vi.hoisted(() => ({
  applyFulfillmentSelectionIfPendingMock: vi.fn(),
}));

vi.mock('../../../../tools/checkout', () => ({
  applyFulfillmentSelectionIfPending: applyFulfillmentSelectionIfPendingMock,
}));

vi.mock('../../../../services/cart.service', () => ({
  handleViewCartFromWebhook: vi.fn().mockResolvedValue('carrito actualizado'),
}));

import { handleViewCartFromWebhook } from '../../../../services/cart.service';
import { SelectDeliveryHandler, SelectTakeAwayHandler } from '../selectFulfillmentHandler';
import type { EnrichedContext } from '../../types';

const baseCtx = {
  business: { id: 'biz-1' },
  customer: { id: 'cust-1', phone_number: '+5491100000000' },
  conversationId: 'conv-1',
  to: '+5491100000000',
  payload: {},
} as unknown as EnrichedContext;

describe('SelectFulfillmentHandler — delega la vigencia a applyFulfillmentSelectionIfPending', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('vigente: aplica y muestra el carrito actualizado', async () => {
    applyFulfillmentSelectionIfPendingMock.mockResolvedValue({ applied: true });

    const result = await SelectDeliveryHandler.execute(baseCtx);

    expect(applyFulfillmentSelectionIfPendingMock).toHaveBeenCalledWith(
      'biz-1',
      '+5491100000000',
      'conv-1',
      'DELIVERY'
    );
    expect(handleViewCartFromWebhook).toHaveBeenCalledOnce();
    expect(result).not.toBeNull();
  });

  it('botón vencido (already_resolved/no_pending/wrong_draft): responde "Opción vencida" sin tocar el carrito', async () => {
    applyFulfillmentSelectionIfPendingMock.mockResolvedValue({
      applied: false,
      error: 'already_resolved',
    });

    const result = await SelectTakeAwayHandler.execute(baseCtx);

    expect(handleViewCartFromWebhook).not.toHaveBeenCalled();
    expect(result?.isInteractive).toBe(true);
  });

  it('sin carrito activo: responde el aviso de "sin pedido activo"', async () => {
    applyFulfillmentSelectionIfPendingMock.mockResolvedValue({
      applied: false,
      error: 'no_active_cart',
    });

    const result = await SelectDeliveryHandler.execute(baseCtx);

    expect(typeof result?.content).toBe('string');
    expect(handleViewCartFromWebhook).not.toHaveBeenCalled();
  });
});
