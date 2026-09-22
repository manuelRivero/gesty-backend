import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    conversation_state: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../repositories', () => ({
  omitConversationMetadataKeys: vi.fn().mockResolvedValue({}),
  patchConversationMetadata: vi.fn().mockResolvedValue({}),
  updateConversationState: vi.fn().mockResolvedValue({}),
}));

vi.mock('../conversationCanvas.service', () => ({
  maybeClearConversationCanvas: vi.fn().mockResolvedValue(false),
}));

import { prisma } from '../../lib/prisma';
import {
  omitConversationMetadataKeys,
  patchConversationMetadata,
  updateConversationState,
} from '../../repositories';
import { clearReservationSessionAfterCancel } from '../reservationSessionReset.service';

describe('clearReservationSessionAfterCancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('omite draft/flags de reserva y limpia COMPLETAR_RESERVA del Ledger', async () => {
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: {
        reservation_agent_active: true,
        reservation_draft: { date: '21/09/2026', partySize: 2 },
        reservation_faq_delegation: { active: true },
        peopleCount: 2,
        intentLedger: {
          COMPLETAR_RESERVA: { surfaceCount: 2 },
          RESERVA_PROXIMA: { emitted: true },
          COMPLETAR_PEDIDO: { surfaceCount: 1 },
        },
      },
    } as never);

    await clearReservationSessionAfterCancel('conv-1');

    expect(omitConversationMetadataKeys).toHaveBeenCalledWith(
      'conv-1',
      expect.arrayContaining([
        'reservation_agent_active',
        'reservation_draft',
        'reservation_faq_delegation',
        'pendingReservationDishFaq',
      ])
    );

    expect(patchConversationMetadata).toHaveBeenCalledWith('conv-1', {
      welcomeEligible: true,
    });
    expect(patchConversationMetadata).toHaveBeenCalledWith('conv-1', {
      intentLedger: { COMPLETAR_PEDIDO: { surfaceCount: 1 } },
    });

    expect(updateConversationState).toHaveBeenCalledWith('conv-1', { mode: 'GLOBAL' });
  });

  it('si solo quedaba ledger de reserva, omite intentLedger entero', async () => {
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: {
        intentLedger: {
          COMPLETAR_RESERVA: { surfaceCount: 1 },
        },
      },
    } as never);

    await clearReservationSessionAfterCancel('conv-2');

    expect(omitConversationMetadataKeys).toHaveBeenCalledWith('conv-2', ['intentLedger']);
  });
});
