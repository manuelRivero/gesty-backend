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

vi.mock('../../services/ordersCapabilityGate.service', () => ({
  assertCanOrder: vi.fn().mockResolvedValue({ ok: true }),
}));

import { prisma } from '../../lib/prisma';
import { MenuService } from '../../services/menu.service';
import { buildPendingPartySizeOrderContextLines } from '../../services/partySizeGoal.service';
import {
  addCartItemTool,
  planOrderLinesTool,
  savePartySizeTool,
  searchProductsTool,
} from '../index';

const configFor = (turnStartedAt: string) => ({
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: '2026-09-27T00:00:00.000Z',
    turnStartedAt,
  },
});

const TURN_1 = configFor('2026-09-27T16:00:00.000Z');
const TURN_2 = configFor('2026-09-27T16:05:00.000Z');

const planLines = [
  { hint: 'ceviche', requestedQuantity: 1 },
  { hint: 'lomo', requestedQuantity: 1 },
];

describe('pedido en espera cuando falta el número', () => {
  let metadata: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    metadata = {};
    findOrCreateConversationState.mockImplementation(async () => ({ metadata }));
    patchConversationMetadata.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) => {
        metadata = { ...metadata, ...patch };
      }
    );
    omitConversationMetadataKeys.mockImplementation(async (_id: string, keys: string[]) => {
      const next = { ...metadata };
      for (const key of keys) delete next[key];
      metadata = next;
    });
  });

  it('save_party_size restaura el plan estructurado como cola sin perder líneas', async () => {
    metadata = {
      pendingPartySizeOrder: {
        source: 'plan',
        summary: '1× ceviche, 1× lomo',
        setAt: '2026-09-27T16:00:00.000Z',
        turnStartedAt: TURN_1.configurable.turnStartedAt,
        lines: planLines,
      },
    };

    const saved = JSON.parse(
      (await savePartySizeTool.func({ count: 3 }, undefined, TURN_2)) as string
    );

    expect(saved.success).toBe(true);
    expect(saved.heldOrder).toBe('1× ceviche, 1× lomo');
    expect(saved.activeLine).toEqual({ hint: 'ceviche', requestedQuantity: 1 });
    expect(saved.followUp.instruction).toContain('cola estructurada');
    expect(metadata.peopleCount).toBe(3);
    expect(metadata.requestedPartySize).toBe(3);
    expect(metadata.pendingPartySizeOrder).toBeUndefined();
    expect(metadata.pendingOrderLines).toMatchObject({
      lines: [
        { hint: 'ceviche', requestedQuantity: 1, status: 'active' },
        { hint: 'lomo', requestedQuantity: 1, status: 'queued' },
      ],
    });
  });

  it('save_party_size sin count rechaza la llamada sin producir efectos', async () => {
    const result = JSON.parse(
      (await savePartySizeTool.func({} as never, undefined, TURN_2)) as string
    );

    expect(result).toEqual({ success: false, error: 'count_required', missing: 'count' });
    expect(patchConversationMetadata).not.toHaveBeenCalled();
    expect(metadata.peopleCount).toBeUndefined();
  });

  it('después de guardar el número el estado sigue mostrando el pedido sin historial', () => {
    const lines = buildPendingPartySizeOrderContextLines({
      peopleCount: 3,
      requestedPartySize: 3,
      pendingPartySizeOrder: {
        source: 'plan',
        summary: '1× ceviche, 1× lomo',
        setAt: '2026-09-27T16:00:00.000Z',
      },
    });
    expect(lines.join('\n')).toContain('1× ceviche, 1× lomo');
    expect(lines.join('\n')).toMatch(/personas ya guardadas/);
  });

  it('lookup y plan en paralelo terminan en el plan', async () => {
    patchConversationMetadata.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        metadata = { ...metadata, ...patch };
      }
    );

    await Promise.all([
      searchProductsTool.func({ keyword: 'ceviche' }, undefined, TURN_1),
      planOrderLinesTool.func({ lines: planLines }, undefined, TURN_1),
    ]);

    expect(metadata.pendingPartySizeOrder).toMatchObject({
      source: 'plan',
      summary: '1× ceviche, 1× lomo',
      lines: planLines,
    });
  });

  it('dos lookups del mismo turno se suman sin duplicar', async () => {
    patchConversationMetadata.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        metadata = { ...metadata, ...patch };
      }
    );

    await Promise.all([
      searchProductsTool.func({ keyword: 'ceviche' }, undefined, TURN_1),
      searchProductsTool.func({ keyword: 'lomo' }, undefined, TURN_1),
      searchProductsTool.func({ keyword: 'ceviche' }, undefined, TURN_1),
    ]);

    const pending = metadata.pendingPartySizeOrder as { summary: string; source: string };
    expect(pending.source).toBe('lookup');
    expect(pending.summary.split(', ').sort()).toEqual(['ceviche', 'lomo']);
  });

  it('un lookup de otro turno reemplaza al lookup anterior', async () => {
    await searchProductsTool.func({ keyword: 'empanadas' }, undefined, TURN_1);
    await searchProductsTool.func({ keyword: 'pizza' }, undefined, TURN_2);

    expect(metadata.pendingPartySizeOrder).toMatchObject({
      source: 'lookup',
      summary: 'pizza',
    });
    expect(MenuService.searchMenuItemsByKeyword).not.toHaveBeenCalled();
  });

  it('el plan gana a un lookup previo y a uno posterior', async () => {
    await searchProductsTool.func({ keyword: 'papa' }, undefined, TURN_1);
    await planOrderLinesTool.func({ lines: planLines }, undefined, TURN_1);
    await searchProductsTool.func({ keyword: 'arroz' }, undefined, TURN_1);

    expect(metadata.pendingPartySizeOrder).toMatchObject({
      source: 'plan',
      summary: '1× ceviche, 1× lomo',
    });
  });

  it('plan_order_lines exitoso transfiere la intención a la cola y limpia el pending', async () => {
    metadata = {
      peopleCount: 3,
      requestedPartySize: 3,
      pendingPartySizeOrder: {
        source: 'lookup',
        summary: 'ceviche',
        setAt: '2026-09-27T16:00:00.000Z',
        turnStartedAt: TURN_1.configurable.turnStartedAt,
      },
    };

    const planned = JSON.parse(
      (await planOrderLinesTool.func({ lines: planLines }, undefined, TURN_2)) as string
    );

    expect(planned.success).toBe(true);
    expect(metadata.pendingOrderLines).toBeTruthy();
    expect(metadata.pendingPartySizeOrder).toBeUndefined();
  });

  it('plan_order_lines deja sin cantidad las líneas no cuantificadas aunque haya party size', async () => {
    metadata = { peopleCount: 3, requestedPartySize: 3 };
    const lines = [{ hint: 'papas a la huancaína' }, { hint: 'ceviche' }];

    const planned = JSON.parse(
      (await planOrderLinesTool.func({ lines }, undefined, TURN_2)) as string
    );

    expect(planned.success).toBe(true);
    expect(metadata.peopleCount).toBe(3);
    expect(
      (metadata.pendingOrderLines as { lines: Array<{ requestedQuantity: number | null }> }).lines
        .map((line) => line.requestedQuantity)
    ).toEqual([1, 1]);
  });

  it('una búsqueda con resultados no consume el pending', async () => {
    metadata = {
      peopleCount: 3,
      requestedPartySize: 3,
      pendingPartySizeOrder: {
        source: 'lookup',
        summary: 'ceviche',
        setAt: '2026-09-27T16:00:00.000Z',
      },
    };
    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValue([
      { id: 'a', name: 'Ceviche Clásico' },
      { id: 'b', name: 'Ceviche Mixto' },
    ] as never);

    await searchProductsTool.func({ keyword: 'ceviche' }, undefined, TURN_2);

    expect(metadata.pendingPartySizeOrder).toMatchObject({ summary: 'ceviche' });
  });

  it('variation_required no crea pendingPartySizeOrder ni borra pendingVariation', async () => {
    metadata = {
      peopleCount: 3,
      requestedPartySize: 3,
    };
    vi.mocked(prisma.menu_item.findFirst).mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Ceviche clasico con variaciones',
      serves_people: 1,
      discount_type: null,
      discount_value: null,
      variations: ['poco picante', 'muy picante'],
      menu_item_price: [],
    } as never);

    const result = JSON.parse(
      (await addCartItemTool.func(
        { productId: '11111111-1111-1111-1111-111111111111', quantity: 3 },
        undefined,
        TURN_2
      )) as string
    );

    expect(result.error).toBe('variation_required');
    expect(metadata.pendingPartySizeOrder).toBeUndefined();
    expect(metadata.pendingVariation).toMatchObject({
      productName: 'Ceviche clasico con variaciones',
    });
  });
});
