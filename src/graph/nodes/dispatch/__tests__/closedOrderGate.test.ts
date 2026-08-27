/**
 * Tests del gate de horario cerrado en `interactiveSubgraphNode` y
 * `nlpSubgraphNode` (tipable vía extractPendingTurnResponse — §3.11).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../lib/prisma', () => ({
  prisma: {
    menu_item: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('../../../../controllers/webhook/dispachers', () => ({
  dispatchInteractive: vi.fn(),
  dispatchIntent: vi.fn(),
}));

vi.mock('../../../../repositories', () => ({
  patchConversationMetadata: vi.fn().mockResolvedValue(undefined),
  omitConversationMetadataKeys: vi.fn().mockResolvedValue(undefined),
  findOrCreateConversationState: vi.fn(),
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
  shouldAskIntentConfirmation: vi.fn(() => false),
}));

vi.mock('../../../../agents/reactAgent', () => ({
  runHybridReactAgent: vi.fn(),
}));

vi.mock('../../checkout', () => ({
  activateCheckoutSessionIfCartHasItems: vi.fn(),
  applyDefaultFulfillmentIfSingleOption: vi.fn(),
  resolveCheckoutAgentHandlerResult: vi.fn(),
}));

vi.mock('../../../../services/intentAmbiguityConfirmation.service', () => ({
  buildIntentAmbiguityInteractiveMessage: vi.fn(),
}));

vi.mock('../../../../config/env', () => ({
  isReservationAgentEnabled: vi.fn(() => false),
  isCheckoutAgentEnabled: vi.fn(() => false),
}));

vi.mock('../../../../services/ai/extractPendingTurnResponse', () => ({
  extractPendingTurnResponse: vi.fn(),
  formatPendingExtractionBlock: vi.fn(),
}));

import { interactiveSubgraphNode, nlpSubgraphNode } from '../index';
import { prisma } from '../../../../lib/prisma';
import { dispatchInteractive } from '../../../../controllers/webhook/dispachers';
import {
  patchConversationMetadata,
  omitConversationMetadataKeys,
} from '../../../../repositories';
import {
  CLOSED_ORDER_CANCELLED_BOT_MESSAGE,
  NO_PENDING_CLOSED_ORDER_BOT_MESSAGE,
} from '../../../../services/productQuery/botMessages';
import {
  CANCEL_CLOSED_ORDER,
  CONFIRM_CLOSED_ORDER,
} from '../../../../services/businessHours.service';
import { extractPendingTurnResponse } from '../../../../services/ai/extractPendingTurnResponse';
import { runHybridReactAgent } from '../../../../agents/reactAgent';
import type { AgentState } from '../../../state';

const menuItemFindFirst = prisma.menu_item.findFirst as unknown as ReturnType<typeof vi.fn>;
const dispatchInteractiveMock = dispatchInteractive as unknown as ReturnType<typeof vi.fn>;
const patchMetaMock = patchConversationMetadata as unknown as ReturnType<typeof vi.fn>;
const extractPendingMock = extractPendingTurnResponse as unknown as ReturnType<typeof vi.fn>;
const hybridMock = runHybridReactAgent as unknown as ReturnType<typeof vi.fn>;

const interactiveBaseState = (
  overrides: {
    payloadId?: string;
    ordersWhenClosed?: boolean;
    metadata?: Record<string, unknown>;
  } = {}
): AgentState =>
  ({
    webhookContext: { payloadId: overrides.payloadId ?? null } as never,
    enrichedCtx: {
      payloadId: overrides.payloadId ?? null,
      conversationState: { metadata: overrides.metadata ?? {} },
    } as never,
    conversation: { id: 'conv-1' } as never,
    business: { id: 'biz-1' } as never,
    businessClosedButOperating: true,
    businessConfig: { orders_when_closed: overrides.ordersWhenClosed ?? true } as never,
    businessStatus: { nextOpenText: 'mañana a las 9' } as never,
  }) as unknown as AgentState;

const nlpBaseState = (
  overrides: {
    userMessage?: string;
    ordersWhenClosed?: boolean;
    metadata?: Record<string, unknown>;
  } = {}
): AgentState => {
  const metadata = overrides.metadata ?? {
    pending_closed_add_item: 'ADD_ITEM:prod-1',
  };
  return {
    webhookContext: {
      message: { text: { body: overrides.userMessage ?? 'sí, dale' } },
      to: '+5491100000000',
    } as never,
    enrichedCtx: {
      conversationState: { metadata },
    } as never,
    workingConversationState: { metadata } as never,
    conversation: { id: 'conv-1' } as never,
    business: { id: 'biz-1' } as never,
    customer: { phone_number: '+5491100000000' } as never,
    businessClosedButOperating: true,
    businessConfig: { orders_when_closed: overrides.ordersWhenClosed ?? true } as never,
    businessStatus: { nextOpenText: 'mañana a las 9' } as never,
    hasAddress: false,
    isInCoverage: false,
  } as unknown as AgentState;
};

describe('gate de horario cerrado — interactiveSubgraphNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    menuItemFindFirst.mockResolvedValue(null);
  });

  it('cerrado + orders_when_closed=false + ADD_ITEM → mensaje de pedidos no disponibles', async () => {
    const state = interactiveBaseState({ payloadId: 'ADD_ITEM:prod-1', ordersWhenClosed: false });
    const result = await interactiveSubgraphNode(state);
    expect(result.handlerResult?.content).toContain('cerrados');
    expect(dispatchInteractiveMock).not.toHaveBeenCalled();
    expect(patchMetaMock).not.toHaveBeenCalled();
  });

  it('cerrado + orders_when_closed=true + ADD_ITEM sin flag → pide confirmación y persiste pending_closed_add_item', async () => {
    const state = interactiveBaseState({ payloadId: 'ADD_ITEM:prod-1', ordersWhenClosed: true });
    const result = await interactiveSubgraphNode(state);
    expect(result.handlerResult?.isInteractive).toBe(true);
    expect(patchMetaMock).toHaveBeenCalledWith('conv-1', {
      pending_closed_add_item: 'ADD_ITEM:prod-1',
    });
    expect(dispatchInteractiveMock).not.toHaveBeenCalled();
  });

  it('CONFIRM_CLOSED_ORDER ejecuta el pendiente y setea closed_order_confirmed_at', async () => {
    dispatchInteractiveMock.mockResolvedValue({ content: 'listo', isInteractive: false });
    const state = interactiveBaseState({
      payloadId: CONFIRM_CLOSED_ORDER,
      ordersWhenClosed: true,
      metadata: { pending_closed_add_item: 'ADD_ITEM:prod-1' },
    });
    const result = await interactiveSubgraphNode(state);
    expect(result.handlerResult?.content).toBe('listo');
    expect(patchMetaMock).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ closed_order_confirmed_at: expect.any(String) })
    );
    expect(omitConversationMetadataKeys).toHaveBeenCalledWith('conv-1', [
      'pending_closed_add_item',
    ]);
    expect(dispatchInteractiveMock).toHaveBeenCalledWith(
      expect.objectContaining({ payloadId: 'ADD_ITEM:prod-1' })
    );
  });

  it('CANCEL_CLOSED_ORDER omite pending y responde cancelación', async () => {
    const state = interactiveBaseState({
      payloadId: CANCEL_CLOSED_ORDER,
      ordersWhenClosed: true,
      metadata: { pending_closed_add_item: 'ADD_ITEM:prod-1' },
    });
    const result = await interactiveSubgraphNode(state);
    expect(result.handlerResult?.content).toBe(CLOSED_ORDER_CANCELLED_BOT_MESSAGE);
    expect(omitConversationMetadataKeys).toHaveBeenCalledWith('conv-1', [
      'pending_closed_add_item',
    ]);
    expect(dispatchInteractiveMock).not.toHaveBeenCalled();
  });

  it('sin pending_closed_add_item, CONFIRM_CLOSED_ORDER → mensaje de "nada pendiente"', async () => {
    const state = interactiveBaseState({
      payloadId: CONFIRM_CLOSED_ORDER,
      ordersWhenClosed: true,
      metadata: {},
    });
    const result = await interactiveSubgraphNode(state);
    expect(result.handlerResult?.content).toBe(NO_PENDING_CLOSED_ORDER_BOT_MESSAGE);
  });

  it('con closed_order_confirmed_at ya seteado, un segundo ADD_ITEM NO vuelve a pedir confirmación', async () => {
    dispatchInteractiveMock.mockResolvedValue({
      content: 'agregado sin preguntar',
      isInteractive: false,
    });
    const state = interactiveBaseState({
      payloadId: 'ADD_ITEM:prod-2',
      ordersWhenClosed: true,
      metadata: { closed_order_confirmed_at: new Date().toISOString() },
    });
    const result = await interactiveSubgraphNode(state);
    expect(result.handlerResult?.content).toBe('agregado sin preguntar');
    expect(patchMetaMock).not.toHaveBeenCalled();
    expect(dispatchInteractiveMock).toHaveBeenCalled();
  });

  it('producto con variaciones sin índice → devuelve el picker sin activar el gate', async () => {
    menuItemFindFirst.mockResolvedValue({ variations: ['Especial', 'Roquefort'] });
    dispatchInteractiveMock.mockResolvedValue({
      content: '',
      isInteractive: true,
      followUps: [{ type: 'list', listMessage: {} }],
    });
    const state = interactiveBaseState({ payloadId: 'ADD_ITEM:prod-3', ordersWhenClosed: true });
    const result = await interactiveSubgraphNode(state);
    expect(dispatchInteractiveMock).toHaveBeenCalled();
    expect(patchMetaMock).not.toHaveBeenCalled();
    expect(result.handlerResult?.isInteractive).toBe(true);
  });
});

describe('gate de horario cerrado — nlpSubgraphNode tipable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hybridMock.mockResolvedValue({ content: 'hybrid', isInteractive: false });
  });

  it('fulfilled confirmed=true → setea closed_order_confirmed_at, omite pending y despacha ADD_ITEM', async () => {
    extractPendingMock.mockResolvedValue({
      status: 'fulfilled',
      value: { confirmed: true },
      confidence: 0.95,
      source: 'llm',
      reason: null,
    });
    dispatchInteractiveMock.mockResolvedValue({ content: 'agregado', isInteractive: false });

    const result = await nlpSubgraphNode(nlpBaseState({ userMessage: 'sí, dale' }));

    expect(result.handlerResult?.content).toBe('agregado');
    expect(patchMetaMock).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ closed_order_confirmed_at: expect.any(String) })
    );
    expect(omitConversationMetadataKeys).toHaveBeenCalledWith('conv-1', [
      'pending_closed_add_item',
    ]);
    expect(dispatchInteractiveMock).toHaveBeenCalledWith(
      expect.objectContaining({ payloadId: 'ADD_ITEM:prod-1' })
    );
    expect(hybridMock).not.toHaveBeenCalled();
  });

  it('fulfilled confirmed=false → omite pending, mensaje cancel, sin despachar ADD_ITEM', async () => {
    extractPendingMock.mockResolvedValue({
      status: 'fulfilled',
      value: { confirmed: false },
      confidence: 0.9,
      source: 'llm',
      reason: null,
    });

    const result = await nlpSubgraphNode(nlpBaseState({ userMessage: 'mejor no' }));

    expect(result.handlerResult?.content).toBe(CLOSED_ORDER_CANCELLED_BOT_MESSAGE);
    expect(omitConversationMetadataKeys).toHaveBeenCalledWith('conv-1', [
      'pending_closed_add_item',
    ]);
    expect(dispatchInteractiveMock).not.toHaveBeenCalled();
    expect(hybridMock).not.toHaveBeenCalled();
  });

  it('reprompt → reenvía confirmación interactiva sin consumir pending', async () => {
    extractPendingMock.mockResolvedValue({
      status: 'reprompt',
      value: null,
      confidence: 0.4,
      source: 'llm',
      reason: 'no claro',
    });

    const result = await nlpSubgraphNode(nlpBaseState({ userMessage: 'mmm no sé' }));

    expect(result.handlerResult?.isInteractive).toBe(true);
    expect(omitConversationMetadataKeys).not.toHaveBeenCalled();
    expect(dispatchInteractiveMock).not.toHaveBeenCalled();
    expect(hybridMock).not.toHaveBeenCalled();
  });

  it('delegate → reenvía botones sin consumir pending (no pasa al híbrido)', async () => {
    extractPendingMock.mockResolvedValue({
      status: 'delegate',
      value: null,
      confidence: 0.7,
      source: 'llm',
      reason: 'otro tema',
    });

    const result = await nlpSubgraphNode(
      nlpBaseState({ userMessage: 'mostrame el menú de postres' })
    );

    expect(result.handlerResult?.isInteractive).toBe(true);
    expect(omitConversationMetadataKeys).not.toHaveBeenCalled();
    expect(hybridMock).not.toHaveBeenCalled();
  });
});
