import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../repositories', () => ({
  patchConversationMetadata: vi.fn().mockResolvedValue(undefined),
  omitConversationMetadataKeys: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../cart.service', () => ({
  buildAddItemMessage: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: { findFirst: vi.fn() },
    draft_order_item: { updateMany: vi.fn() },
  },
}));

import {
  parsePendingVariation,
  resolvePendingVariationFromMessage,
  extractNoteAfterVariation,
  setPendingVariation,
  clearPendingVariation,
  tryHandlePendingVariationHybrid,
} from '../pendingVariation.service';
import { patchConversationMetadata, omitConversationMetadataKeys } from '../../repositories';
import { buildAddItemMessage } from '../cart.service';

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

  it('match compuesto: variación + nota residual', () => {
    const meta = {
      pendingVariation: {
        productId: 'p1',
        productName: 'Ceviche clásico con variaciones',
        variations: ['Con poco picante', 'Muy picante'],
        quantity: 1,
        askedAt: '2026-08-10T12:00:00.000Z',
      },
    };
    const resolved = resolvePendingVariationFromMessage(
      meta,
      'Muy picante Pero que no tenga tanta cebolla'
    );
    expect(resolved.status).toBe('matched');
    if (resolved.status === 'matched') {
      expect(resolved.variation).toBe('Muy picante');
      expect(resolved.note).toMatch(/cebolla/i);
    }
  });

  it('extractNoteAfterVariation limpia conectores', () => {
    expect(extractNoteAfterVariation('Muy picante', 'Muy picante')).toBeNull();
    expect(
      extractNoteAfterVariation('Muy picante, sin tanta cebolla', 'Muy picante')
    ).toMatch(/cebolla/i);
  });

  it('set/clear pendingVariation tocan metadata', async () => {
    await setPendingVariation({
      conversationId: 'conv-1',
      productId: 'p1',
      productName: 'Pizza',
      variations: ['Especial', 'Roquefort'],
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

  it('tryHandlePendingVariationHybrid suma con variación y nota', async () => {
    vi.mocked(buildAddItemMessage).mockResolvedValue(
      '¡Listo! Sumé el ceviche.' as never
    );

    const result = await tryHandlePendingVariationHybrid({
      conversationId: 'conv-1',
      message: { text: { body: 'Muy picante sin cebolla' } },
      conversationState: {
        metadata: {
          pendingVariation: {
            productId: 'p1',
            productName: 'Ceviche',
            variations: ['Con poco picante', 'Muy picante'],
            quantity: 1,
            askedAt: '2026-08-10T12:00:00.000Z',
          },
        },
      },
      business: { id: 'biz-1' },
      conversation: { id: 'conv-1' },
      customer: { phone_number: '+54911' },
      payload: {} as never,
      phoneNumberId: 'x',
      to: '+54911',
      value: {},
    } as never);

    expect(result).not.toBeNull();
    expect(buildAddItemMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'p1',
      expect.anything(),
      1,
      'add',
      'Muy picante'
    );
    expect(omitConversationMetadataKeys).toHaveBeenCalled();
    expect(String(result!.content)).toMatch(/Listo|Anoté|cebolla/i);
  });
});
