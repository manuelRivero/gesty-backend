/**
 * PLAN-ACCION-SHOPPING-ONLY.md — `refreshMenuItemEmbedding` es el único
 * punto de llamada a `getProductEmbedding` (OpenAI) del flujo admin de
 * productos: debe negarse a generar/regenerar un embedding cuando el
 * negocio no tiene IA habilitada comercialmente, sin borrar el embedding
 * existente ni lanzar.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    menu_item: { findUnique: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../openai.service', () => ({
  getProductEmbedding: vi.fn(),
}));

vi.mock('../../billing/businessCapabilities.service', () => ({
  resolveBusinessCapabilities: vi.fn(),
}));

import { prisma } from '../../../lib/prisma';
import { getProductEmbedding } from '../openai.service';
import { resolveBusinessCapabilities } from '../../billing/businessCapabilities.service';
import { refreshMenuItemEmbedding } from '../menuItemEmbedding.service';

const mockedFindUnique = prisma.menu_item.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedExecuteRaw = prisma.$executeRaw as unknown as ReturnType<typeof vi.fn>;
const mockedGetEmbedding = getProductEmbedding as unknown as ReturnType<typeof vi.fn>;
const mockedResolveCapabilities = resolveBusinessCapabilities as unknown as ReturnType<
  typeof vi.fn
>;

const MENU_ITEM_ID = 'item-1';
const BUSINESS_ID = 'biz-1';

function fullMenuItem() {
  return {
    id: MENU_ITEM_ID,
    business_id: BUSINESS_ID,
    name: 'Muzzarella',
    description: null,
    ingredients: null,
    serves_people: 2,
    is_available: true,
    variations: [],
    menu_category: null,
    menu_item_price: [],
  };
}

describe('refreshMenuItemEmbedding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it('no llama a OpenAI si el negocio no tiene IA habilitada (Shopping Only)', async () => {
    mockedFindUnique.mockResolvedValueOnce({ business_id: BUSINESS_ID });
    mockedResolveCapabilities.mockResolvedValueOnce({
      ai: { allowed: false, reason: 'plan_ai_disabled' },
      shopping: { allowed: true, reason: 'ok' },
    });

    const result = await refreshMenuItemEmbedding(MENU_ITEM_ID);

    expect(result).toEqual({ updated: false, reason: 'ai_capability_denied' });
    expect(mockedGetEmbedding).not.toHaveBeenCalled();
    expect(mockedExecuteRaw).not.toHaveBeenCalled();
  });

  it('regenera el embedding cuando el negocio sí tiene IA habilitada', async () => {
    mockedFindUnique
      .mockResolvedValueOnce({ business_id: BUSINESS_ID })
      .mockResolvedValueOnce(fullMenuItem());
    mockedResolveCapabilities.mockResolvedValueOnce({
      ai: { allowed: true, reason: 'ok' },
      shopping: { allowed: true, reason: 'ok' },
    });

    const result = await refreshMenuItemEmbedding(MENU_ITEM_ID);

    expect(result).toEqual({ updated: true });
    expect(mockedGetEmbedding).toHaveBeenCalledTimes(1);
    expect(mockedExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it('devuelve item_not_found sin consultar capacidades si el producto no existe', async () => {
    mockedFindUnique.mockResolvedValueOnce(null);

    const result = await refreshMenuItemEmbedding('ghost');

    expect(result).toEqual({ updated: false, reason: 'item_not_found' });
    expect(mockedResolveCapabilities).not.toHaveBeenCalled();
    expect(mockedGetEmbedding).not.toHaveBeenCalled();
  });
});
