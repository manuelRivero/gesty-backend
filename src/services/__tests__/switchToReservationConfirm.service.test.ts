import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: { findFirst: vi.fn() },
  },
}));

vi.mock('../../repositories', () => ({
  patchConversationMetadata: vi.fn().mockResolvedValue(undefined),
  omitConversationMetadataKeys: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../order.service', () => ({
  buildCancelOrderMessage: vi.fn().mockResolvedValue('cancelado'),
}));

vi.mock('../ai/extractPendingTurnResponse', () => ({
  extractPendingTurnResponse: vi.fn(),
}));

import { prisma } from '../../lib/prisma';
import {
  patchConversationMetadata,
  omitConversationMetadataKeys,
} from '../../repositories';
import { buildCancelOrderMessage } from '../order.service';
import {
  CONFIRM_CANCEL_ORDER_FOR_RESERVATION_PAYLOAD,
  DECLINE_SWITCH_TO_RESERVATION_PAYLOAD,
  SWITCH_TO_RESERVATION_QUESTION,
  applySwitchToReservationConfirm,
  applySwitchToReservationDecline,
  buildSwitchToReservationConfirmMessage,
  buildSwitchToReservationContextLines,
  countActiveCartItems,
  getPendingSwitchToReservation,
  setPendingSwitchToReservation,
} from '../switchToReservationConfirm.service';

describe('switchToReservationConfirm.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('countActiveCartItems lee el draft activo', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      _count: { draft_order_item: 3 },
    } as never);

    await expect(
      countActiveCartItems({ businessId: 'biz-1', customerPhone: '+54911' })
    ).resolves.toBe(3);
  });

  it('setPendingSwitchToReservation persiste reason + askedAt', async () => {
    await setPendingSwitchToReservation('conv-1', 'quiere reservar');
    expect(patchConversationMetadata).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        pending_switch_to_reservation: expect.objectContaining({
          reason: 'quiere reservar',
          askedAt: expect.any(String),
        }),
      })
    );
  });

  it('getPendingSwitchToReservation / context lines', () => {
    expect(getPendingSwitchToReservation({})).toBeNull();
    const pending = getPendingSwitchToReservation({
      pending_switch_to_reservation: {
        reason: 'reservar',
        askedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(pending?.reason).toBe('reservar');
    const lines = buildSwitchToReservationContextLines({
      pending_switch_to_reservation: pending,
    });
    expect(lines.some((l) => l.includes(SWITCH_TO_RESERVATION_QUESTION))).toBe(true);
  });

  it('buildSwitchToReservationConfirmMessage usa payloads de botón', () => {
    const msg = buildSwitchToReservationConfirmMessage();
    expect(msg.type).toBe('interactive');
    expect(msg.interactive.type).toBe('button');
    const ids = msg.interactive.action.buttons.map((b) => b.reply.id);
    expect(ids).toEqual([
      CONFIRM_CANCEL_ORDER_FOR_RESERVATION_PAYLOAD,
      DECLINE_SWITCH_TO_RESERVATION_PAYLOAD,
    ]);
  });

  it('applySwitchToReservationConfirm wipe draft + limpia pending', async () => {
    await applySwitchToReservationConfirm({
      conversation: { id: 'conv-1' } as never,
      businessId: 'biz-1',
      customerPhone: '+54911',
    });
    expect(buildCancelOrderMessage).toHaveBeenCalledWith(
      { id: 'conv-1' },
      'biz-1',
      '+54911',
      { target: 'draft' }
    );
    expect(omitConversationMetadataKeys).toHaveBeenCalledWith('conv-1', [
      'pending_switch_to_reservation',
    ]);
  });

  it('applySwitchToReservationDecline mantiene carrito (solo limpia pending)', async () => {
    const result = await applySwitchToReservationDecline('conv-1');
    expect(omitConversationMetadataKeys).toHaveBeenCalledWith('conv-1', [
      'pending_switch_to_reservation',
    ]);
    expect(buildCancelOrderMessage).not.toHaveBeenCalled();
    expect(result.isInteractive).toBe(false);
    expect(String(result.content)).toMatch(/seguimos con tu pedido/i);
  });
});
