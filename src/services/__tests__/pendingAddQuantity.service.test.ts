import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPendingAddQuantityContextLines,
  buildPendingAddQuantityMessage,
  isPendingAddQuantityReply,
  parsePendingAddQuantity,
  shouldForceHybridForPendingAddQuantity,
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

  it('buildPendingAddQuantityMessage sugiere sin imponer ni tipables numéricos', () => {
    const msg = buildPendingAddQuantityMessage(basePending());
    expect(msg).toMatch(/Cuántas querés sumar/i);
    expect(msg).toMatch(/Cada unidad es para 1 persona/i);
    expect(msg).toMatch(
      /Como el pedido es para 3 personas te sugiero 3 unidades, pero podés pedir las que gustes/i
    );
    expect(msg).not.toMatch(/voy a sumar/i);
    expect(msg).not.toMatch(/Escribí un número/i);
    expect(msg).not.toMatch(/\(sugerido\)/i);
    expect(msg).not.toMatch(/• \*Cancelar\*/);
    expect(msg).not.toMatch(/3×/);
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

  it('shouldForceHybridForPendingAddQuantity solo con ledger activo', () => {
    expect(shouldForceHybridForPendingAddQuantity({})).toBe(false);
    expect(
      shouldForceHybridForPendingAddQuantity({ pendingAddQuantity: basePending() })
    ).toBe(true);
  });

  it('isPendingAddQuantityReply: pending de este mismo turno no confirma', () => {
    const turnStartedAt = '2026-08-12T20:00:00.000Z';
    const pending = basePending({ askedAt: '2026-08-12T20:00:01.000Z' });
    expect(
      isPendingAddQuantityReply({
        pending,
        productId: pending.productId,
        quantity: 2,
        turnStartedAt,
      })
    ).toBe(false);
  });

  it('isPendingAddQuantityReply: pending de un turno anterior sí confirma', () => {
    const turnStartedAt = '2026-08-12T20:01:00.000Z';
    const pending = basePending({ askedAt: '2026-08-12T20:00:00.000Z' });
    expect(
      isPendingAddQuantityReply({
        pending,
        productId: pending.productId,
        quantity: 2,
        turnStartedAt,
      })
    ).toBe(true);
  });
});
