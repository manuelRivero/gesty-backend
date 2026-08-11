import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPendingItemNoteContextLines,
  buildPendingItemNoteMessage,
  parsePendingItemNote,
  type PendingItemNote,
} from '../pendingItemNote.service';

vi.mock('../../repositories', () => ({
  patchConversationMetadata: vi.fn(),
  omitConversationMetadataKeys: vi.fn(),
}));

const basePending = (over: Partial<PendingItemNote> = {}): PendingItemNote => ({
  askedAt: new Date().toISOString(),
  productId: null,
  productName: null,
  source: 'tipable',
  ...over,
});

describe('pendingItemNote.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parsePendingItemNote valida shape', () => {
    expect(parsePendingItemNote(null)).toBeNull();
    expect(parsePendingItemNote(basePending())).toMatchObject({
      source: 'tipable',
      productId: null,
    });
    expect(
      parsePendingItemNote(
        basePending({
          productId: '11111111-1111-1111-1111-111111111111',
          productName: 'Chicha',
          noteText: 'sin azúcar',
          candidateProductIds: ['11111111-1111-1111-1111-111111111111'],
        })
      )
    ).toMatchObject({
      productName: 'Chicha',
      noteText: 'sin azúcar',
    });
  });

  it('buildPendingItemNoteMessage: varios ítems pide plato', () => {
    const msg = buildPendingItemNoteMessage(2);
    expect(msg).toMatch(/Qué querés anotar/i);
    expect(msg).toMatch(/sobre cuál/i);
    expect(msg).toMatch(/chupe sin picante/i);
  });

  it('buildPendingItemNoteMessage: 1 ítem no pide plato', () => {
    const msg = buildPendingItemNoteMessage(1, 'Chicha morada');
    expect(msg).toMatch(/Qué querés anotar/i);
    expect(msg).toMatch(/Chicha morada/);
    expect(msg).not.toMatch(/sobre cuál/i);
  });

  it('context lines priorizan nota sobre shortlist/complemento', () => {
    const lines = buildPendingItemNoteContextLines({
      pendingItemNote: basePending({
        productId: '11111111-1111-1111-1111-111111111111',
        productName: 'Chupe',
      }),
    });
    const text = lines.join('\n');
    expect(text).toMatch(/Nota de ítem pendiente/i);
    expect(text).toMatch(/update_item_note/i);
    expect(text).toMatch(/clear_pending_item_note/i);
    expect(text).toMatch(/PROHIBIDO add_cart_item/i);
    expect(text).toMatch(/present_complement_suggestions/i);
  });
});
