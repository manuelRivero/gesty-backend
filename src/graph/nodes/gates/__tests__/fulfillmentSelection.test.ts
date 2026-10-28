/**
 * fulfillmentSelectionNode (flujo legacy, CHECKOUT_AGENT_ENABLED=false):
 * al presentar los botones de fulfillment, debe vincular la solicitud
 * pendiente al draft activo vía `markFulfillmentPending` — no debe volver a
 * escribir el `pending_fulfillment_action` suelto de antes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { markFulfillmentPendingMock } = vi.hoisted(() => ({
  markFulfillmentPendingMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../tools/checkout', () => ({
  markFulfillmentPending: markFulfillmentPendingMock,
}));

vi.mock('../../../../config/env', () => ({
  isCheckoutAgentEnabled: () => false,
}));

vi.mock('../../../../lib/prisma', () => ({
  prisma: {
    draft_order: { findFirst: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));

import { fulfillmentSelectionNode } from '../fulfillmentSelection';
import { prisma } from '../../../../lib/prisma';
import { ConversationIntent } from '../../../../types/conversationIntent';
import type { AgentState } from '../../../state';

const baseState = (overrides: Partial<AgentState> = {}): AgentState =>
  ({
    dataCollectionDelegated: false,
    skipAIPersistence: false,
    contextRoute: 'interactive',
    businessConfig: { delivery_enabled: true, takeaway_enabled: true },
    detection: { intent: ConversationIntent.ADD_ITEM },
    webhookContext: { to: '+5491100000000' },
    business: { id: 'biz-1' },
    conversation: { id: 'conv-1' },
    workingConversationState: { metadata: {} },
    ...overrides,
  } as unknown as AgentState);

describe('fulfillmentSelectionNode — vincula la solicitud al draft activo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('con ambos métodos habilitados y draft sin fulfillment: presenta botones y registra la solicitud', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      id: 'draft-1',
      fulfillment_type: null,
    } as never);

    const update = await fulfillmentSelectionNode(baseState());

    expect(markFulfillmentPendingMock).toHaveBeenCalledWith('biz-1', '+5491100000000', 'conv-1');
    expect(update.handlerResult?.isInteractive).toBe(true);
  });

  it('fulfillment ya resuelto: no presenta botones ni registra nada', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      id: 'draft-1',
      fulfillment_type: 'DELIVERY',
    } as never);

    const update = await fulfillmentSelectionNode(baseState());

    expect(markFulfillmentPendingMock).not.toHaveBeenCalled();
    expect(update).toEqual({});
  });

  it('sin draft activo: no hace nada', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(null);

    const update = await fulfillmentSelectionNode(baseState());

    expect(markFulfillmentPendingMock).not.toHaveBeenCalled();
    expect(update).toEqual({});
  });
});
