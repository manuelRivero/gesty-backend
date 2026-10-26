import { describe, expect, it, vi } from 'vitest';

const { evaluateIncomingInteractionMock, findOrCreateConversationStateMock } = vi.hoisted(() => ({
  evaluateIncomingInteractionMock: vi.fn(),
  findOrCreateConversationStateMock: vi.fn(async () => ({
    conversation_id: 'conv-1',
    metadata: {},
    is_human_handled: false,
  })),
}));

vi.mock('../../../../repositories', () => ({
  findOrCreateConversationState: findOrCreateConversationStateMock,
  findRecentMessagesForDetectionContext: vi.fn(async () => []),
  findDefaultCustomerAddress: vi.fn(async () => null),
  findCoverageZoneForAddress: vi.fn(async () => null),
}));
vi.mock('../../../../services/activeInteraction.service', () => ({
  evaluateIncomingInteraction: evaluateIncomingInteractionMock,
}));
vi.mock('../../../../services/whatsappTypingIndicator.service', () => ({
  sendTypingIndicator: vi.fn(),
}));
vi.mock('../../../../lib/prisma', () => ({
  prisma: { customer_address: { update: vi.fn() } },
}));
vi.mock('../checkout', () => ({
  clearCheckoutSessionIfStale: vi.fn(async () => false),
}));

import { buildDetectionContextNode } from '../index';

const baseState = {
  webhookContext: { to: '+5491100000000', message: { type: 'interactive' }, payloadId: 'RESERVATION_SLOT:old-slot' },
  businessConfig: { bot_enabled: true },
  business: { id: 'biz-1' },
  customer: { id: 'cust-1', phone_number: '+5491100000000' },
  conversation: { id: 'conv-1', started_at: new Date() },
  isOwnerAssistant: false,
} as never;

describe('buildDetectionContextNode — gate de vigencia de interacciones', () => {
  it('"stale": corta el turno con contextRoute stale_interaction y un handlerResult fijo, sin tocar el routing normal', async () => {
    evaluateIncomingInteractionMock.mockResolvedValueOnce('stale');

    const update = await buildDetectionContextNode(baseState);

    expect(evaluateIncomingInteractionMock).toHaveBeenCalledWith('conv-1', {
      isInteractivePayload: true,
      payloadId: 'RESERVATION_SLOT:old-slot',
    });
    expect(update.contextRoute).toBe('stale_interaction');
    expect(update.handlerResult?.isInteractive).toBe(true);
    // No llega a calcular nada del routing normal (reserva/checkout/onboarding/nlp).
    expect(update).not.toHaveProperty('detectionContext');
  });

  it('"none": no corta el turno — sigue construyendo el contexto normal', async () => {
    evaluateIncomingInteractionMock.mockResolvedValueOnce('none');

    const update = await buildDetectionContextNode(baseState);

    expect(update.contextRoute).not.toBe('stale_interaction');
    expect(update.handlerResult).toBeUndefined();
  });
});
