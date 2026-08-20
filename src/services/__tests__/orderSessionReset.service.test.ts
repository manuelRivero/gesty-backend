import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    conversation_state: {
      findUnique: vi.fn(),
    },
    conversation: {
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock('../../repositories', () => ({
  omitConversationMetadataKeys: vi.fn().mockResolvedValue({}),
  patchConversationMetadata: vi.fn().mockResolvedValue({}),
  updateConversationState: vi.fn().mockResolvedValue({}),
}));

import { prisma } from '../../lib/prisma';
import {
  omitConversationMetadataKeys,
  patchConversationMetadata,
  updateConversationState,
} from '../../repositories';
import { clearOrderSessionAfterCancel } from '../orderSessionReset.service';

describe('clearOrderSessionAfterCancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('limpia peopleCountResume, Ledger de pedido y deja COMPLETAR_RESERVA', async () => {
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: {
        peopleCountResume: { userMessage: 'ceviche', detection: { intent: 'PRODUCT_QUERY' } },
        awaitingPartySize: true,
        checkout_active: true,
        lastOffer: { kind: 'ADD_ITEM', productId: 'p1', productName: 'X', suggestedQuantity: 1, offeredAt: '', source: 'hybrid_cta' },
        intentLedger: {
          COMPLETAR_PEDIDO: { surfaceCount: 3 },
          RETOMAR_TAREA_INTERRUMPIDA: { surfaceCount: 1 },
          RECOLECTAR_PARTY_SIZE: { surfaceCount: 1 },
          OBTENER_PERSONAS_DEL_PEDIDO: { surfaceCount: 2 },
          COMPLETAR_RESERVA: { surfaceCount: 1 },
        },
      },
    } as any);

    await clearOrderSessionAfterCancel('conv-1');

    expect(patchConversationMetadata).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        checkout_active: false,
        awaitingPartySize: false,
        awaitingPeopleCount: false,
        requestedPartySize: null,
        peopleCount: null,
      })
    );

    expect(omitConversationMetadataKeys).toHaveBeenCalledWith(
      'conv-1',
      expect.arrayContaining([
        'peopleCountResume',
        'lastOffer',
        'pendingProductSelection',
        'pendingItemNote',
        'pendingAddQuantity',
        'pendingVariation',
        'intentCandidates',
        'pending_address_text',
        'pendingOrderSelection',
        'pendingOrderCandidateIds',
        'pendingOrderLines',
        'pendingTipables',
        'lastCtaPayload',
      ])
    );

    expect(patchConversationMetadata).toHaveBeenCalledWith('conv-1', {
      intentLedger: { COMPLETAR_RESERVA: { surfaceCount: 1 } },
    });

    expect(updateConversationState).toHaveBeenCalledWith('conv-1', { mode: 'GLOBAL' });
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { lastReferencedProductId: null },
    });
  });

  it('si no queda nada en el Ledger, omite la clave intentLedger', async () => {
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: {
        intentLedger: {
          COMPLETAR_PEDIDO: { surfaceCount: 1 },
          RETOMAR_TAREA_INTERRUMPIDA: { surfaceCount: 1 },
        },
      },
    } as any);

    await clearOrderSessionAfterCancel('conv-2');

    expect(omitConversationMetadataKeys).toHaveBeenCalledWith('conv-2', ['intentLedger']);
  });

  it('limpia alerts de pedido del Ledger y preserva RESERVA_PROXIMA', async () => {
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: {
        intentLedger: {
          FUERA_DE_COBERTURA: { emitted: true },
          PAGO_RECHAZADO: { emitted: true },
          ITEM_SIN_STOCK: { emitted: true },
          NEGOCIO_POR_CERRAR: { emitted: true },
          RESERVA_PROXIMA: { emitted: true },
          COMPLETAR_RESERVA: { surfaceCount: 2 },
        },
      },
    } as any);

    await clearOrderSessionAfterCancel('conv-3');

    expect(patchConversationMetadata).toHaveBeenCalledWith('conv-3', {
      intentLedger: {
        RESERVA_PROXIMA: { emitted: true },
        COMPLETAR_RESERVA: { surfaceCount: 2 },
      },
    });
  });
});
