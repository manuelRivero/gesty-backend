/**
 * Test del guard de tipo de mensaje, con foco en la excepción de imagen (D1):
 * solo pasa cuando hay una orden de transferencia impaga reciente para ese
 * cliente. Audio/video/sticker/documento siguen bloqueados siempre.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../repositories', () => ({
  findOrCreateConversationState: vi.fn(),
}));

vi.mock('../../../../services/payment/transferProof.service', () => ({
  findOrderAwaitingTransferProof: vi.fn(),
}));

import { messageTypeGuardNode } from '../messageTypeGuard';
import { findOrCreateConversationState } from '../../../../repositories';
import { findOrderAwaitingTransferProof } from '../../../../services/payment/transferProof.service';
import type { AgentState } from '../../../state';

const mockedFindOrderAwaitingTransferProof = findOrderAwaitingTransferProof as unknown as ReturnType<
  typeof vi.fn
>;
const mockedFindOrCreateConversationState = findOrCreateConversationState as unknown as ReturnType<
  typeof vi.fn
>;

const baseState = (overrides: Partial<AgentState> = {}): AgentState =>
  ({
    conversationId: 'conv-1',
    business: { id: 'biz-1' } as never,
    customer: { id: 'cust-1' } as never,
    webhookContext: { message: { type: 'text' } } as never,
    ...overrides,
  }) as AgentState;

const withMessageType = (type: string): AgentState =>
  baseState({ webhookContext: { message: { type } } as never });

describe('messageTypeGuardNode — excepción de imagen (D1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFindOrCreateConversationState.mockResolvedValue({ metadata: {} });
  });

  it('deja pasar una imagen cuando hay orden de transferencia pendiente', async () => {
    const order = { id: 'order-1', total_amount: null, created_at: new Date() };
    mockedFindOrderAwaitingTransferProof.mockResolvedValueOnce(order);

    const result = await messageTypeGuardNode(withMessageType('image'));

    expect(result.earlyExit).toBeUndefined();
    expect(result.handlerResult).toBeUndefined();
    expect(result.awaitingTransferProofOrder).toEqual(order);
  });

  it('sigue mostrando el aviso "No puedo procesar" con botón SUPPORT si no hay orden pendiente', async () => {
    mockedFindOrderAwaitingTransferProof.mockResolvedValueOnce(null);

    const result = await messageTypeGuardNode(withMessageType('image'));

    expect(result.earlyExit).toBe('unsupported_message_type');
    expect(result.handlerResult?.isInteractive).toBe(true);
  });

  it.each(['audio', 'video', 'sticker', 'document'])(
    '%s siempre queda bloqueado, incluso con orden de transferencia pendiente',
    async (type) => {
      mockedFindOrderAwaitingTransferProof.mockResolvedValueOnce({
        id: 'order-1',
        total_amount: null,
        created_at: new Date(),
      });

      const result = await messageTypeGuardNode(withMessageType(type));

      expect(result.earlyExit).toBe('unsupported_message_type');
      expect(mockedFindOrderAwaitingTransferProof).not.toHaveBeenCalled();
    }
  );
});
