/**
 * Espejo en DB de `findCartLineByPayloadId`: las listas de cantidad y el
 * remover resuelven contra Postgres, no contra un carrito ya cargado.
 * Misma regla — línea primero, producto como compatibilidad.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: { draft_order_item: { findFirst: vi.fn() } },
}));

import { prisma } from '../../lib/prisma';
import { handleDraftOrderItem } from '../order.service';

const DRAFT = { id: 'draft-1' } as never;
const LINE = { id: 'line-1', product_id: 'pizza' };

describe('handleDraftOrderItem', () => {
  beforeEach(() => vi.clearAllMocks());

  it('busca primero por id de línea y no consulta por producto si la encuentra', async () => {
    vi.mocked(prisma.draft_order_item.findFirst).mockResolvedValueOnce(LINE as never);

    const found = await handleDraftOrderItem(DRAFT, 'line-1');

    expect(found).toBe(LINE);
    expect(prisma.draft_order_item.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.draft_order_item.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { draft_order_id: 'draft-1', id: 'line-1' } })
    );
  });

  it('cae a la búsqueda por producto cuando el payload es de antes del deploy', async () => {
    vi.mocked(prisma.draft_order_item.findFirst)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(LINE as never);

    const found = await handleDraftOrderItem(DRAFT, 'pizza');

    expect(found).toBe(LINE);
    expect(prisma.draft_order_item.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { draft_order_id: 'draft-1', menu_item: { id: 'pizza' } },
      })
    );
  });

  it('devuelve null si no matchea por ninguna de las dos vías', async () => {
    vi.mocked(prisma.draft_order_item.findFirst).mockResolvedValue(null as never);
    await expect(handleDraftOrderItem(DRAFT, 'nada')).resolves.toBeNull();
  });
});
