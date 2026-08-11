import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPendingAddQuantityContextLines,
  buildPendingAddQuantityMessage,
  parsePendingAddQuantity,
  type PendingAddQuantity,
} from '../pendingAddQuantity.service';

vi.mock('../../repositories', () => ({
  patchConversationMetadata: vi.fn(),
  omitConversationMetadataKeys: vi.fn(),
}));

const basePending = (over: Partial<PendingAddQuantity> = {}): PendingAddQuantity => ({
  productId: '11111111-1111-1111-1111-111111111111',
  productName: 'Chupe de camarones',
  suggestedQuantity: 3,
  servesPeople: 1,
  partySize: 3,
  source: 'deterministic',
  askedAt: new Date().toISOString(),
  ...over,
});

describe('pendingAddQuantity.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parsePendingAddQuantity valida shape', () => {
    expect(parsePendingAddQuantity(null)).toBeNull();
    expect(parsePendingAddQuantity(basePending())).toMatchObject({
      productName: 'Chupe de camarones',
      suggestedQuantity: 3,
    });
  });

  it('buildPendingAddQuantityMessage sugiere sin imponer', () => {
    const msg = buildPendingAddQuantityMessage(basePending());
    expect(msg).toMatch(/Cuántas querés sumar/i);
    expect(msg).toMatch(/3×/);
    expect(msg).toMatch(/sugerido/i);
    expect(msg).not.toMatch(/voy a sumar/i);
  });

  it('context lines instruyen al agente (ledger tipable, no router)', () => {
    const lines = buildPendingAddQuantityContextLines({
      pendingAddQuantity: basePending(),
    });
    expect(lines.join('\n')).toMatch(/Cantidad pendiente/i);
    expect(lines.join('\n')).toMatch(/add_cart_item/i);
    expect(lines.join('\n')).toMatch(/clear_pending_add_quantity/i);
    expect(lines.join('\n')).toMatch(/sugerido 3/i);
  });
});
