/**
 * plan_order_lines cierra la ola de complemento al abrir cola multi-línea.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: { findFirst: vi.fn() },
  },
}));

vi.mock('../../services/menu.service', () => ({ MenuService: {} }));

const setPendingOrderLines = vi.fn();
const getActiveOrderLine = vi.fn();
const omitConversationMetadataKeys = vi.fn();
const clearComplementSuggestionSnapshot = vi.fn();

vi.mock('../../services/pendingOrderLines.service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../services/pendingOrderLines.service')>();
  return {
    ...actual,
    setPendingOrderLines: (...args: unknown[]) => setPendingOrderLines(...args),
    getActiveOrderLine: (...args: unknown[]) => getActiveOrderLine(...args),
  };
});

vi.mock('../../repositories/conversationState.repository', () => ({
  patchConversationMetadata: vi.fn(),
  omitConversationMetadataKeys: (...args: unknown[]) =>
    omitConversationMetadataKeys(...args),
  findOrCreateConversationState: vi.fn().mockResolvedValue({
    metadata: { peopleCount: 2 },
  }),
}));

vi.mock('../../services/complementSuggestions.service', () => ({
  clearComplementSuggestionSnapshot: (...args: unknown[]) =>
    clearComplementSuggestionSnapshot(...args),
}));

import { planOrderLinesTool } from '../index';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

describe('plan_order_lines + ola de complemento', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPendingOrderLines.mockResolvedValue({
      lines: [
        { id: 'a', hint: 'adobo', requestedQuantity: 1, status: 'active' },
        { id: 'b', hint: 'ají de gallina', requestedQuantity: 1, status: 'queued' },
      ],
      sourceMessage: 'adobo, ají de gallina',
      createdAt: new Date().toISOString(),
    });
    getActiveOrderLine.mockReturnValue({
      id: 'a',
      hint: 'adobo',
      requestedQuantity: 1,
      status: 'active',
    });
    omitConversationMetadataKeys.mockResolvedValue(undefined);
    clearComplementSuggestionSnapshot.mockResolvedValue(undefined);
  });

  it('limpia shortlist/ola de complemento al crear la cola', async () => {
    const raw = await planOrderLinesTool.invoke(
      {
        lines: [
          { hint: 'adobo', requestedQuantity: 1 },
          { hint: 'ají de gallina', requestedQuantity: 1 },
        ],
      },
      CONFIG
    );
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    expect(result.success).toBe(true);
    expect(omitConversationMetadataKeys).toHaveBeenCalledWith(
      'conv-1',
      expect.arrayContaining([
        'pendingProductSelection',
        'pendingComplementSelection',
        'candidateProductIds',
      ])
    );
    expect(clearComplementSuggestionSnapshot).toHaveBeenCalledWith('conv-1');
  });
});
