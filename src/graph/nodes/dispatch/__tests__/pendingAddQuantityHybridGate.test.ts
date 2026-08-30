/**
 * Con pendingAddQuantity, NLP puede decir MODIFY_QUANTITY (cerrado) ante
 * «quiero tres». El gate debe forzar el híbrido, no ModifyQuantityHandler.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/prisma', () => ({
  prisma: {
    menu_item: { findFirst: vi.fn() },
    draft_order: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('../../../../controllers/webhook/dispachers', () => ({
  dispatchInteractive: vi.fn(),
  dispatchIntent: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../../repositories', () => ({
  patchConversationMetadata: vi.fn().mockResolvedValue(undefined),
  omitConversationMetadataKeys: vi.fn().mockResolvedValue(undefined),
  findOrCreateConversationState: vi.fn(async (_id: string, _meta?: unknown) => ({
    metadata: {
      pendingAddQuantity: {
        productId: '11111111-1111-1111-1111-111111111111',
        productName: 'Ají de gallina',
        suggestedQuantity: 3,
        servesPeople: 1,
        partySize: 3,
        source: 'hybrid',
        askedAt: new Date().toISOString(),
      },
      requestedPartySize: 3,
      peopleCount: 3,
    },
  })),
}));

vi.mock('../../../../repositories/reservation.repository', () => ({
  findActiveEnvironmentsByBusinessId: vi.fn().mockResolvedValue([]),
  fetchReservationSlotsForBusinessDate: vi.fn(),
}));

vi.mock('../../../../agents/reservationAgent', () => ({
  runReservationAgent: vi.fn(),
}));

vi.mock('../../../../services/ai/detection.service', () => ({
  detectIntentWithConfidence: vi.fn(),
}));

vi.mock('../../../../agents/reactAgent', () => ({
  runHybridReactAgent: vi.fn(),
}));

vi.mock('../../checkout', () => ({
  activateCheckoutSessionIfCartHasItems: vi.fn(),
  applyDefaultFulfillmentIfSingleOption: vi.fn(),
  resolveCheckoutAgentHandlerResult: vi.fn(),
}));

vi.mock('../../../../config/env', () => ({
  isReservationAgentEnabled: vi.fn(() => false),
  isCheckoutAgentEnabled: vi.fn(() => false),
}));

import { nlpSubgraphNode } from '../index';
import { runHybridReactAgent } from '../../../../agents/reactAgent';
import { dispatchIntent } from '../../../../controllers/webhook/dispachers';
import { findOrCreateConversationState } from '../../../../repositories';
import type { AgentState } from '../../../state';

const pendingMeta = {
  pendingAddQuantity: {
    productId: '11111111-1111-1111-1111-111111111111',
    productName: 'Ají de gallina',
    suggestedQuantity: 3,
    servesPeople: 1,
    partySize: 3,
    source: 'hybrid' as const,
    askedAt: new Date().toISOString(),
  },
  requestedPartySize: 3,
  peopleCount: 3,
};

describe('gate pendingAddQuantity → híbrido', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findOrCreateConversationState).mockResolvedValue({
      metadata: pendingMeta,
    } as never);
    vi.mocked(runHybridReactAgent).mockResolvedValue({
      kind: 'response',
      handlerResult: {
        content: '¡Listo! Sumé 3× Ají de gallina',
        isInteractive: false,
      },
    } as never);
  });

  it('con pendingAddQuantity + MODIFY_QUANTITY llama al híbrido, no a dispatchIntent', async () => {
    const state = {
      webhookContext: {
        message: { text: { body: 'Quiero tres' }, type: 'text' },
        to: '54911',
      },
      enrichedCtx: {
        conversationState: { metadata: pendingMeta },
        conversation: { id: 'conv-1' },
        business: { id: 'biz-1' },
        customer: { phone_number: '54911' },
        message: { text: { body: 'Quiero tres' }, type: 'text' },
        to: '54911',
      },
      conversation: { id: 'conv-1', lastReferencedProductId: null },
      customer: { id: 'cust-1', phone_number: '54911' },
      business: { id: 'biz-1' },
      conversationState: { metadata: pendingMeta },
      hasAddress: true,
      isInCoverage: true,
      detectionContext: {},
    } as unknown as AgentState;

    const update = await nlpSubgraphNode(state);

    expect(runHybridReactAgent).toHaveBeenCalled();
    expect(dispatchIntent).not.toHaveBeenCalled();
    expect(update.handlerResult?.content).toMatch(/Sumé 3/i);
    expect(update.dataCollectionDelegated).toBe(true);
  });
});
