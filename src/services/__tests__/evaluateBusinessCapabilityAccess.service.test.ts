import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    menu_item: { count: vi.fn() },
  },
}));

vi.mock('../businessConfig.service', () => ({
  getBusinessConfig: vi.fn(),
}));

vi.mock('../paymentMethods.service', () => ({
  listOfferedPaymentMethods: vi.fn(),
}));

import { prisma } from '../../lib/prisma';
import { getBusinessConfig } from '../businessConfig.service';
import { listOfferedPaymentMethods } from '../paymentMethods.service';
import {
  CAPABILITY_BLOCKED_MESSAGE,
  evaluateBusinessCapabilityAccess,
} from '../evaluateBusinessCapabilityAccess.service';

const mockedCount = prisma.menu_item.count as unknown as ReturnType<typeof vi.fn>;
const mockedConfig = getBusinessConfig as unknown as ReturnType<typeof vi.fn>;
const mockedOffered = listOfferedPaymentMethods as unknown as ReturnType<
  typeof vi.fn
>;

const baseConfig = {
  bot_enabled: true,
  orders_enabled: false,
  checkout_enabled: false,
  reservations_enabled: false,
  delivery_enabled: false,
  takeaway_enabled: false,
  external_delivery_enabled: false,
};

describe('evaluateBusinessCapabilityAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedOffered.mockResolvedValue([]);
    mockedCount.mockResolvedValue(0);
  });

  it('bloquea sin pedidos ni reservas', async () => {
    mockedConfig.mockResolvedValue({ ...baseConfig });
    const result = await evaluateBusinessCapabilityAccess('biz-1');
    expect(result.mode).toBe('blocked');
    expect(result.canOrder).toBe(false);
    expect(result.message).toBe(CAPABILITY_BLOCKED_MESSAGE);
  });

  it('modo reservations_only cuando hay reservas y no canOrder', async () => {
    mockedConfig.mockResolvedValue({
      ...baseConfig,
      reservations_enabled: true,
    });
    const result = await evaluateBusinessCapabilityAccess('biz-1');
    expect(result.mode).toBe('reservations_only');
    expect(result.canOrder).toBe(false);
    expect(result.message).toBeNull();
  });

  it('canOrder solo con flag + menú + pago + fulfillment', async () => {
    mockedConfig.mockResolvedValue({
      ...baseConfig,
      orders_enabled: true,
      takeaway_enabled: true,
    });
    mockedOffered.mockResolvedValue([{ id: 'cash' }]);
    mockedCount.mockResolvedValue(1);

    const result = await evaluateBusinessCapabilityAccess('biz-1');
    expect(result.mode).toBe('orders_only');
    expect(result.canOrder).toBe(true);
    expect(result.hasPayment).toBe(true);
    expect(result.hasActiveMenu).toBe(true);
    expect(result.hasFulfillment).toBe(true);
  });

  it('full cuando canOrder y reservas', async () => {
    mockedConfig.mockResolvedValue({
      ...baseConfig,
      orders_enabled: true,
      reservations_enabled: true,
      delivery_enabled: true,
    });
    mockedOffered.mockResolvedValue([{ id: 'online' }]);
    mockedCount.mockResolvedValue(2);

    const result = await evaluateBusinessCapabilityAccess('biz-1');
    expect(result.mode).toBe('full');
    expect(result.canOrder).toBe(true);
  });

  it('orders_enabled sin menú no da canOrder', async () => {
    mockedConfig.mockResolvedValue({
      ...baseConfig,
      orders_enabled: true,
      takeaway_enabled: true,
    });
    mockedOffered.mockResolvedValue([{ id: 'cash' }]);
    mockedCount.mockResolvedValue(0);

    const result = await evaluateBusinessCapabilityAccess('biz-1');
    expect(result.canOrder).toBe(false);
    expect(result.mode).toBe('blocked');
  });
});
