import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../repositories', () => ({
  patchConversationMetadata: vi.fn().mockResolvedValue(undefined),
  omitConversationMetadataKeys: vi.fn().mockResolvedValue(undefined),
}));

import {
  parsePendingVariation,
  setPendingVariation,
  clearPendingVariation,
  buildPendingVariationContextLines,
} from '../pendingVariation.service';
import { patchConversationMetadata, omitConversationMetadataKeys } from '../../repositories';

describe('pendingVariation.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parsePendingVariation valida shape', () => {
    expect(parsePendingVariation(null)).toBeNull();
    expect(
      parsePendingVariation({
        productId: 'p1',
        productName: 'Ceviche',
        variations: ['Muy picante', 'Con poco picante'],
        quantity: 1,
        askedAt: '2026-08-10T12:00:00.000Z',
      })
    ).toEqual(
      expect.objectContaining({
        productId: 'p1',
        productName: 'Ceviche',
        variations: ['Muy picante', 'Con poco picante'],
      })
    );
  });

  it('set/clear pendingVariation tocan metadata', async () => {
    await setPendingVariation({
      conversationId: 'conv-1',
      productId: 'p1',
      productName: 'Ceviche',
      variations: ['Muy picante'],
      quantity: 2,
    });
    expect(patchConversationMetadata).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        pendingVariation: expect.objectContaining({
          productId: 'p1',
          quantity: 2,
        }),
      })
    );

    await clearPendingVariation('conv-1');
    expect(omitConversationMetadataKeys).toHaveBeenCalledWith('conv-1', [
      'pendingVariation',
    ]);
  });

  it('context lines instruyen al agente (ledger tipable, no router)', () => {
    const lines = buildPendingVariationContextLines({
      pendingVariation: {
        productId: 'p1',
        productName: 'Ceviche',
        variations: ['Muy picante', 'Suave'],
        quantity: 1,
        askedAt: '2026-08-10T12:00:00.000Z',
      },
    });
    const text = lines.join('\n');
    expect(text).toMatch(/Variación pendiente/i);
    expect(text).toMatch(/add_cart_item/i);
    expect(text).toMatch(/clear_pending_variation/i);
    expect(text).toMatch(/Muy picante/);
  });
});
