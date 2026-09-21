/**
 * Híbrido → reserva con carrito: botones + tipable §3.11 (wipe draft → reserva).
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
  findOrCreateConversationState: vi.fn(async () => ({ metadata: {} })),
}));

vi.mock('../../../../repositories/reservation.repository', () => ({
  findActiveEnvironmentsByBusinessId: vi.fn().mockResolvedValue([]),
  fetchReservationSlotsForBusinessDate: vi.fn(),
}));

vi.mock('../../../../agents/reservationAgent', () => ({
  runReservationAgent: vi.fn(),
}));

vi.mock('../../../../agents/reactAgent', () => ({
  runHybridReactAgent: vi.fn(),
}));

vi.mock('../../checkout', () => ({
  activateCheckoutSessionIfCartHasItems: vi.fn(),
  applyDefaultFulfillmentIfSingleOption: vi.fn(),
  resolveCheckoutAgentHandlerResult: vi.fn(),
}));

vi.mock('../../reservation', () => ({
  reservationAgentNode: vi.fn(),
}));

vi.mock('../../../../config/env', () => ({
  isReservationAgentEnabled: vi.fn(() => true),
  isCheckoutAgentEnabled: vi.fn(() => false),
}));

vi.mock('../../../../services/ai/extractPendingTurnResponse', () => ({
  extractPendingTurnResponse: vi.fn(),
  formatPendingExtractionBlock: vi.fn(),
}));

vi.mock('../../../../services/order.service', () => ({
  buildCancelOrderMessage: vi.fn().mockResolvedValue('Pedido cancelado'),
}));

import { interactiveSubgraphNode, nlpSubgraphNode } from '../index';
import { extractPendingTurnResponse } from '../../../../services/ai/extractPendingTurnResponse';
import { runHybridReactAgent } from '../../../../agents/reactAgent';
import { reservationAgentNode } from '../../reservation';
import { buildCancelOrderMessage } from '../../../../services/order.service';
import { omitConversationMetadataKeys } from '../../../../repositories';
import {
  CONFIRM_CANCEL_ORDER_FOR_RESERVATION_PAYLOAD,
  DECLINE_SWITCH_TO_RESERVATION_PAYLOAD,
  SWITCH_TO_RESERVATION_QUESTION,
} from '../../../../services/switchToReservationConfirm.service';
import type { AgentState } from '../../../state';

const PENDING_META = {
  pending_switch_to_reservation: {
    reason: 'quiere reservar',
    askedAt: '2026-01-01T00:00:00.000Z',
  },
};

const baseState = (overrides: {
  payloadId?: string | null;
  userMessage?: string;
  metadata?: Record<string, unknown>;
}): AgentState =>
  ({
    webhookContext: {
      payloadId: overrides.payloadId ?? null,
      message: overrides.userMessage
        ? { text: { body: overrides.userMessage }, type: 'text' }
        : undefined,
      to: '54911',
    },
    enrichedCtx: {
      conversationId: 'conv-1',
      conversationState: { metadata: overrides.metadata ?? {} },
      conversation: { id: 'conv-1' },
      business: { id: 'biz-1' },
      customer: { phone_number: '54911' },
      payloadId: overrides.payloadId ?? null,
      message: overrides.userMessage
        ? { text: { body: overrides.userMessage }, type: 'text' }
        : undefined,
      to: '54911',
    },
    conversation: { id: 'conv-1' },
    customer: { id: 'cust-1', phone_number: '54911' },
    business: { id: 'biz-1' },
    workingConversationState: { metadata: overrides.metadata ?? {} },
    businessConfig: {},
    hasAddress: true,
    isInCoverage: true,
  }) as unknown as AgentState;

describe('switch híbrido → reserva con carrito', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(reservationAgentNode).mockResolvedValue({
      handlerResult: { content: '¿Para cuántos?', isInteractive: false },
    } as never);
  });

  it('botón confirmar → wipe draft + abre reserva', async () => {
    const update = await interactiveSubgraphNode(
      baseState({
        payloadId: CONFIRM_CANCEL_ORDER_FOR_RESERVATION_PAYLOAD,
        metadata: PENDING_META,
      })
    );

    expect(buildCancelOrderMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conv-1' }),
      'biz-1',
      '54911',
      { target: 'draft' }
    );
    expect(omitConversationMetadataKeys).toHaveBeenCalledWith('conv-1', [
      'pending_switch_to_reservation',
    ]);
    expect(reservationAgentNode).toHaveBeenCalled();
    expect(update.handlerResult?.content).toBe('¿Para cuántos?');
  });

  it('botón declinar → mantiene carrito, no abre reserva', async () => {
    const update = await interactiveSubgraphNode(
      baseState({
        payloadId: DECLINE_SWITCH_TO_RESERVATION_PAYLOAD,
        metadata: PENDING_META,
      })
    );

    expect(buildCancelOrderMessage).not.toHaveBeenCalled();
    expect(reservationAgentNode).not.toHaveBeenCalled();
    expect(String(update.handlerResult?.content)).toMatch(/seguimos con tu pedido/i);
  });

  it('tipable "sí" → wipe + reserva', async () => {
    vi.mocked(extractPendingTurnResponse).mockResolvedValue({
      status: 'fulfilled',
      confidence: 0.95,
      source: 'llm',
      value: { confirmed: true },
    } as never);

    const update = await nlpSubgraphNode(
      baseState({ userMessage: 'sí, cancelá', metadata: PENDING_META })
    );

    expect(buildCancelOrderMessage).toHaveBeenCalled();
    expect(reservationAgentNode).toHaveBeenCalled();
    expect(update.handlerResult?.content).toBe('¿Para cuántos?');
    expect(runHybridReactAgent).not.toHaveBeenCalled();
  });

  it('tipable "no" → mantiene carrito', async () => {
    vi.mocked(extractPendingTurnResponse).mockResolvedValue({
      status: 'fulfilled',
      confidence: 0.9,
      source: 'llm',
      value: { confirmed: false },
    } as never);

    const update = await nlpSubgraphNode(
      baseState({ userMessage: 'no, sigo con el pedido', metadata: PENDING_META })
    );

    expect(buildCancelOrderMessage).not.toHaveBeenCalled();
    expect(reservationAgentNode).not.toHaveBeenCalled();
    expect(String(update.handlerResult?.content)).toMatch(/seguimos con tu pedido/i);
  });

  it('tipable ambiguo → re-muestra botones', async () => {
    vi.mocked(extractPendingTurnResponse).mockResolvedValue({
      status: 'reprompt',
      confidence: 0.4,
      source: 'llm',
      value: null,
    } as never);

    const update = await nlpSubgraphNode(
      baseState({ userMessage: 'mmm', metadata: PENDING_META })
    );

    expect(update.handlerResult?.isInteractive).toBe(true);
    const content = update.handlerResult?.content as {
      interactive?: { body?: { text?: string } };
    };
    expect(content.interactive?.body?.text).toContain(SWITCH_TO_RESERVATION_QUESTION);
  });
});
