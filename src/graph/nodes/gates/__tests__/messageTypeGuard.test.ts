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

  it('audio de cliente (no dueño) sigue bloqueado con el aviso genérico', async () => {
    const result = await messageTypeGuardNode(
      baseState({
        isOwnerAssistant: false,
        webhookContext: { message: { type: 'audio' } } as never,
      })
    );

    expect(result.earlyExit).toBe('unsupported_message_type');
    expect(result.handlerResult?.isInteractive).toBe(true);
  });

  it('audio del dueño con ownerAudioBlockedMessage responde el texto puntual (no el aviso genérico)', async () => {
    const result = await messageTypeGuardNode(
      baseState({
        isOwnerAssistant: true,
        ownerAudioBlockedMessage: 'No pude transcribir tu audio.',
        webhookContext: { message: { type: 'audio' } } as never,
      })
    );

    expect(result.earlyExit).toBe('unsupported_message_type');
    expect(result.handlerResult).toEqual({
      content: 'No pude transcribir tu audio.',
      isInteractive: false,
    });
  });
});

/**
 * V-09: `awaiting_address` se borró. El permiso para compartir ubicación no
 * dependía solo de ese flag — quedaba cubierto por los otros tres términos,
 * que sí tienen escritor. Estos casos lo fijan.
 */
describe('messageTypeGuardNode — ubicación dentro del flujo de dirección', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFindOrderAwaitingTransferProof.mockResolvedValue(null);
  });

  it.each([
    ['onboarding_step', { onboarding_step: 'capture' }],
    ['checkout_active', { checkout_active: true }],
    ['onboarding_agent_active', { onboarding_agent_active: true }],
  ])('deja pasar la ubicación con %s', async (_label, metadata) => {
    mockedFindOrCreateConversationState.mockResolvedValue({ metadata });

    const result = await messageTypeGuardNode(withMessageType('location'));

    expect(result.handlerResult).toBeUndefined();
  });

  it('bloquea la ubicación fuera de cualquier flujo de dirección', async () => {
    mockedFindOrCreateConversationState.mockResolvedValue({ metadata: {} });

    const result = await messageTypeGuardNode(withMessageType('location'));

    expect(result.handlerResult).toBeDefined();
  });
});
