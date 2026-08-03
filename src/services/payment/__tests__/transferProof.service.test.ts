import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    orders: {
      findFirst: vi.fn(),
    },
  },
}));

const envState: Record<string, number> = {
  TRANSFER_PROOF_WINDOW_HOURS: 24,
};

vi.mock('../../../config/env', () => ({
  env: new Proxy(
    {},
    {
      get: (_t, prop: string) => envState[prop],
    }
  ),
}));

import { prisma } from '../../../lib/prisma';
import { findOrderAwaitingTransferProof } from '../transferProof.service';

const mockedFindFirst = prisma.orders.findFirst as unknown as ReturnType<typeof vi.fn>;

describe('findOrderAwaitingTransferProof', () => {
  beforeEach(() => {
    mockedFindFirst.mockReset();
    envState.TRANSFER_PROOF_WINDOW_HOURS = 24;
  });

  it('devuelve la orden correcta cuando hay una candidata dentro de ventana', async () => {
    const order = { id: 'order-1', total_amount: null, created_at: new Date() };
    mockedFindFirst.mockResolvedValueOnce(order);

    const result = await findOrderAwaitingTransferProof({
      businessId: 'biz-1',
      customerId: 'cust-1',
    });

    expect(result).toEqual(order);
    expect(mockedFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          business_id: 'biz-1',
          customer_id: 'cust-1',
          payment_method: 'transfer',
          payment_status: 'unpaid',
        }),
        orderBy: { created_at: 'desc' },
      })
    );
  });

  it('devuelve null cuando no hay ninguna orden que matchee (fuera de ventana, método o status)', async () => {
    mockedFindFirst.mockResolvedValueOnce(null);

    const result = await findOrderAwaitingTransferProof({
      businessId: 'biz-1',
      customerId: 'cust-1',
    });

    expect(result).toBeNull();
  });

  it('elige la más reciente cuando hay dos candidatas (delegado al orderBy desc + take implícito de findFirst)', async () => {
    const recent = { id: 'order-recent', total_amount: null, created_at: new Date('2026-08-02T10:00:00Z') };
    mockedFindFirst.mockResolvedValueOnce(recent);

    const result = await findOrderAwaitingTransferProof({
      businessId: 'biz-1',
      customerId: 'cust-1',
      now: new Date('2026-08-03T00:00:00Z'),
    });

    expect(result).toEqual(recent);
    expect(mockedFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { created_at: 'desc' } })
    );
  });

  it('respeta la ventana configurable vía TRANSFER_PROOF_WINDOW_HOURS', async () => {
    envState.TRANSFER_PROOF_WINDOW_HOURS = 1;
    mockedFindFirst.mockResolvedValueOnce(null);

    const now = new Date('2026-08-03T12:00:00Z');
    await findOrderAwaitingTransferProof({ businessId: 'biz-1', customerId: 'cust-1', now });

    const callArgs = mockedFindFirst.mock.calls[0][0];
    const windowStart = callArgs.where.created_at.gte as Date;
    expect(windowStart.getTime()).toBe(now.getTime() - 1 * 60 * 60 * 1000);
  });
});
