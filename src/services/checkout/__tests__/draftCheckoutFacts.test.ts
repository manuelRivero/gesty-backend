import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    draft_order: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prisma } from '../../../lib/prisma';
import {
  DRAFT_CHECKOUT_COLLECTED_FACTS_RESET,
  resetActiveDraftCheckoutFacts,
  resetDraftCheckoutCollectedFacts,
} from '../draftCheckoutFacts';

describe('resetDraftCheckoutCollectedFacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('anula fulfillment, pago y fee del draft (no toca ítems)', async () => {
    vi.mocked(prisma.draft_order.update).mockResolvedValue({} as never);

    await resetDraftCheckoutCollectedFacts('draft-1');

    expect(prisma.draft_order.update).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: DRAFT_CHECKOUT_COLLECTED_FACTS_RESET,
    });
  });

  it('resetActiveDraftCheckoutFacts no-op si no hay draft activo', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(null);

    await resetActiveDraftCheckoutFacts('biz-1', '+54911');

    expect(prisma.draft_order.update).not.toHaveBeenCalled();
  });

  it('resetActiveDraftCheckoutFacts limpia el draft activo', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({ id: 'draft-9' } as never);
    vi.mocked(prisma.draft_order.update).mockResolvedValue({} as never);

    await resetActiveDraftCheckoutFacts('biz-1', '+54911');

    expect(prisma.draft_order.update).toHaveBeenCalledWith({
      where: { id: 'draft-9' },
      data: {
        fulfillment_type: null,
        payment_method: null,
        delivery_fee: null,
      },
    });
  });
});
