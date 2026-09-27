/**
 * El gate de personas no descarta la comida que la tool ya traía.
 * Queda en el estado para el turno siguiente y save_party_size la retoma.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findOrCreateConversationState = vi.fn();
const patchConversationMetadata = vi.fn();
const omitConversationMetadataKeys = vi.fn();

vi.mock('../../lib/prisma', () => ({
  prisma: {
    business: { findUnique: vi.fn() },
    menu_item: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
  },
}));

vi.mock('../../services/menu.service', () => ({
  MenuService: {
    searchMenuItemsByKeyword: vi.fn(),
  },
}));

vi.mock('../../repositories/conversationState.repository', () => ({
  patchConversationMetadata: (...args: unknown[]) => patchConversationMetadata(...args),
  omitConversationMetadataKeys: (...args: unknown[]) =>
    omitConversationMetadataKeys(...args),
}));

vi.mock('../../repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories')>();
  return {
    ...actual,
    findOrCreateConversationState: (...args: unknown[]) =>
      findOrCreateConversationState(...args),
    patchConversationMetadata: (...args: unknown[]) => patchConversationMetadata(...args),
    omitConversationMetadataKeys: (...args: unknown[]) =>
      omitConversationMetadataKeys(...args),
  };
});

import { MenuService } from '../../services/menu.service';
import { planOrderLinesTool, savePartySizeTool, searchProductsTool } from '../index';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

describe('pedido en espera cuando falta el número', () => {
  let metadata: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    metadata = {};
    findOrCreateConversationState.mockImplementation(async () => ({ metadata }));
    patchConversationMetadata.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      metadata = { ...metadata, ...patch };
    });
    omitConversationMetadataKeys.mockImplementation(async (_id: string, keys: string[]) => {
      for (const key of keys) delete metadata[key];
    });
  });

  it('guarda el keyword, deja que la cola lo reemplace y save_party_size lo retoma', async () => {
    const search = JSON.parse(
      (await searchProductsTool.func({ keyword: 'ceviche' }, undefined, CONFIG)) as string
    );
    expect(search.error).toBe('party_size_required');
    expect(search.heldOrder).toBe('ceviche');
    expect(MenuService.searchMenuItemsByKeyword).not.toHaveBeenCalled();

    const searchAgain = JSON.parse(
      (await searchProductsTool.func({ keyword: 'lomo' }, undefined, CONFIG)) as string
    );
    expect(searchAgain.heldOrder).toBe('ceviche, lomo');

    const planned = JSON.parse(
      (await planOrderLinesTool.func(
        {
          lines: [
            { hint: 'ceviche', requestedQuantity: 1 },
            { hint: 'lomo', requestedQuantity: 1 },
          ],
        },
        undefined,
        CONFIG
      )) as string
    );
    expect(planned.heldOrder).toBe('1× ceviche, 1× lomo');
    expect(planned.error).toBe('party_size_required');

    const afterPlan = JSON.parse(
      (await searchProductsTool.func({ keyword: 'papa' }, undefined, CONFIG)) as string
    );
    expect(afterPlan.heldOrder).toBe('1× ceviche, 1× lomo');

    const saved = JSON.parse(
      (await savePartySizeTool.func({ count: 3 }, undefined, CONFIG)) as string
    );
    expect(saved.success).toBe(true);
    expect(saved.heldOrder).toBe('1× ceviche, 1× lomo');
    expect(saved.followUp.instruction).toMatch(/1× ceviche, 1× lomo/);
    expect(saved.followUp.instruction).toMatch(/plan_order_lines/);
    expect(metadata.pendingPartySizeOrder).toBeUndefined();
    expect(metadata.peopleCount).toBe(3);
  });
});
