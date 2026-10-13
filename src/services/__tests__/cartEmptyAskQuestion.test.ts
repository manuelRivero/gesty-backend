import { describe, expect, it, vi } from 'vitest';
import { prisma } from '../../lib/prisma';
import { buildCartSummaryMessage } from '../cart.service';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: { findFirst: vi.fn() },
  },
}));

vi.mock('../orderPortionCoverage', () => ({
  formatCartGuidanceBlock: vi.fn().mockReturnValue(''),
  syncOrderCoverageToConversationState: vi.fn().mockResolvedValue(undefined),
}));

describe('buildCartSummaryMessage — carrito vacío', () => {
  it('ya no emite la fila ASK_QUESTION; conserva VIEW_MENU y no queda una lista vacía', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(null as never);

    const list = await buildCartSummaryMessage({
      businessId: 'biz-1',
      customerPhone: '5490000000',
      conversationId: 'conv-1',
      customerId: 'cust-1',
      currencyCode: 'ARS',
      businessStreetAddress: null,
    });

    const rows = list.action.sections.flatMap((s) => s.rows);
    expect(rows.some((r) => r.id === 'ASK_QUESTION')).toBe(false);
    expect(rows.some((r) => r.id === 'VIEW_MENU')).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });
});
