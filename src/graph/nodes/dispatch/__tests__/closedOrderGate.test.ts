/**
 * Tests del gate de horario cerrado en `interactiveSubgraphNode` (Tarea 2.3
 * de PLAN-ACCION-CALIDAD-CONVERSACIONAL.md). Hoy este gate no tenía ningún
 * test — cubre los casos mínimos del plan: rechazo cuando no se aceptan
 * pedidos fuera de horario, primera confirmación (D5), confirmación repetida
 * dentro de la misma conversación (D5) y el picker de variaciones antes de
 * la confirmación (D7).
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
  isHybridAgentMode: vi.fn(() => false),
  isReservationAgentEnabled: vi.fn(() => false),
  isCheckoutAgentEnabled: vi.fn(() => false),
}));

import { interactiveSubgraphNode } from '../index';
import { prisma } from '../../../../lib/prisma';
import { dispatchInteractive } from '../../../../controllers/webhook/dispachers';
import { patchConversationMetadata, omitConversationMetadataKeys } from '../../../../repositories';
import { NO_PENDING_CLOSED_ORDER_BOT_MESSAGE } from '../../../../services/productQuery/botMessages';
import { CONFIRM_CLOSED_ORDER } from '../../../../services/businessHours.service';
import type { AgentState } from '../../../state';

const menuItemFindFirst = prisma.menu_item.findFirst as unknown as ReturnType<typeof vi.fn>;
const dispatchInteractiveMock = dispatchInteractive as unknown as ReturnType<typeof vi.fn>;
const patchMetaMock = patchConversationMetadata as unknown as ReturnType<typeof vi.fn>;

const baseState = (
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

describe('gate de horario cerrado — interactiveSubgraphNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    menuItemFindFirst.mockResolvedValue(null); // producto sin variaciones por defecto
  });

  it('cerrado + orders_when_closed=false + ADD_ITEM → mensaje de pedidos no disponibles', async () => {
    const state = baseState({ payloadId: 'ADD_ITEM:prod-1', ordersWhenClosed: false });
    const result = await interactiveSubgraphNode(state);
    expect(result.handlerResult?.content).toContain('cerrados');
    expect(dispatchInteractiveMock).not.toHaveBeenCalled();
    expect(patchMetaMock).not.toHaveBeenCalled();
  });

  it('cerrado + orders_when_closed=true + ADD_ITEM sin flag → pide confirmación y persiste pending_closed_add_item', async () => {
    const state = baseState({ payloadId: 'ADD_ITEM:prod-1', ordersWhenClosed: true });
    const result = await interactiveSubgraphNode(state);
    expect(result.handlerResult?.isInteractive).toBe(true);
    expect(patchMetaMock).toHaveBeenCalledWith('conv-1', { pending_closed_add_item: 'ADD_ITEM:prod-1' });
    expect(dispatchInteractiveMock).not.toHaveBeenCalled();
  });

  it('CONFIRM_CLOSED_ORDER ejecuta el pendiente y setea closed_order_confirmed_at', async () => {
    dispatchInteractiveMock.mockResolvedValue({ content: 'listo', isInteractive: false });
    const state = baseState({
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
    expect(omitConversationMetadataKeys).toHaveBeenCalledWith('conv-1', ['pending_closed_add_item']);
  });

  it('sin pending_closed_add_item, CONFIRM_CLOSED_ORDER → mensaje de "nada pendiente"', async () => {
    const state = baseState({ payloadId: CONFIRM_CLOSED_ORDER, ordersWhenClosed: true, metadata: {} });
    const result = await interactiveSubgraphNode(state);
    expect(result.handlerResult?.content).toBe(NO_PENDING_CLOSED_ORDER_BOT_MESSAGE);
  });

  it('con closed_order_confirmed_at ya seteado, un segundo ADD_ITEM NO vuelve a pedir confirmación', async () => {
    dispatchInteractiveMock.mockResolvedValue({ content: 'agregado sin preguntar', isInteractive: false });
    const state = baseState({
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
    const state = baseState({ payloadId: 'ADD_ITEM:prod-3', ordersWhenClosed: true });
    const result = await interactiveSubgraphNode(state);
    expect(dispatchInteractiveMock).toHaveBeenCalled();
    expect(patchMetaMock).not.toHaveBeenCalled();
    expect(result.handlerResult?.isInteractive).toBe(true);
  });
});
