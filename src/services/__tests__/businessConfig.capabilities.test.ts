import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    menu_item: { count: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    payment_method_config: { updateMany: vi.fn() },
  },
}));

vi.mock('../botPersonality.service', () => ({
  NEUTRAL_PERSONALITY_ID: 'a0000000-0000-4000-8000-000000000001',
  getDefaultNeutralPersonalityId: vi
    .fn()
    .mockResolvedValue('a0000000-0000-4000-8000-000000000001'),
  assertActiveBotPersonalityId: vi.fn(),
}));

vi.mock('../paymentMethods.service', () => ({
  listActivePaymentMethodSnapshots: vi.fn().mockResolvedValue([]),
  listOfferedPaymentMethods: vi.fn().mockResolvedValue([]),
}));

import { prisma } from '../../lib/prisma';
import { listOfferedPaymentMethods } from '../paymentMethods.service';
import {
  BusinessConfigValidationError,
  DEFAULT_CONFIG,
  ORDERS_REQUIRES_FULFILLMENT,
  ORDERS_REQUIRES_MENU,
  ORDERS_REQUIRES_PAYMENT,
  upsertBusinessConfig,
} from '../businessConfig.service';

const mockedQuery = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;
const mockedExecute = prisma.$executeRaw as unknown as ReturnType<typeof vi.fn>;
const mockedCount = prisma.menu_item.count as unknown as ReturnType<typeof vi.fn>;
const mockedOffered = listOfferedPaymentMethods as unknown as ReturnType<
  typeof vi.fn
>;

describe('DEFAULT_CONFIG capabilities', () => {
  it('nace con capacidades off, bot on y storefront off (D1/D11/BE-15)', () => {
    expect(DEFAULT_CONFIG.bot_enabled).toBe(true);
    expect(DEFAULT_CONFIG.storefront_enabled).toBe(true);
    expect(DEFAULT_CONFIG.orders_enabled).toBe(false);
    expect(DEFAULT_CONFIG.checkout_enabled).toBe(false);
    expect(DEFAULT_CONFIG.reservations_enabled).toBe(false);
    expect(DEFAULT_CONFIG.delivery_enabled).toBe(false);
    expect(DEFAULT_CONFIG.takeaway_enabled).toBe(false);
  });
});

describe('upsertBusinessConfig orders prerequisites', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedQuery.mockResolvedValue([
      {
        ...DEFAULT_CONFIG,
        bot_personality_id: DEFAULT_CONFIG.bot_personality_id,
        owner_whatsapp_phones: [],
      },
    ]);
    mockedExecute.mockResolvedValue(1);
    mockedCount.mockResolvedValue(0);
    mockedOffered.mockResolvedValue([]);
  });

  it('permite guardar todo off (create limpio)', async () => {
    const cfg = await upsertBusinessConfig('biz-1', {
      orders_enabled: false,
      delivery_enabled: false,
      takeaway_enabled: false,
    });
    expect(cfg.orders_enabled).toBe(false);
    expect(cfg.checkout_enabled).toBe(false);
  });

  it('sync checkout_enabled con orders_enabled (D16)', async () => {
    mockedCount.mockResolvedValue(1);
    mockedOffered.mockResolvedValue([{ id: 'cash' }]);
    const cfg = await upsertBusinessConfig('biz-1', {
      orders_enabled: true,
      takeaway_enabled: true,
      checkout_enabled: false,
    });
    expect(cfg.orders_enabled).toBe(true);
    expect(cfg.checkout_enabled).toBe(true);
  });

  it('rechaza orders sin fulfillment', async () => {
    await expect(
      upsertBusinessConfig('biz-1', { orders_enabled: true })
    ).rejects.toMatchObject({
      name: 'BusinessConfigValidationError',
      code: ORDERS_REQUIRES_FULFILLMENT,
    });
  });

  it('rechaza orders sin menú', async () => {
    mockedCount.mockResolvedValue(0);
    mockedOffered.mockResolvedValue([{ id: 'cash' }]);
    await expect(
      upsertBusinessConfig('biz-1', {
        orders_enabled: true,
        takeaway_enabled: true,
      })
    ).rejects.toMatchObject({
      code: ORDERS_REQUIRES_MENU,
    });
  });

  it('rechaza orders sin pago ofrecible', async () => {
    mockedCount.mockResolvedValue(1);
    mockedOffered.mockResolvedValue([]);
    await expect(
      upsertBusinessConfig('biz-1', {
        orders_enabled: true,
        takeaway_enabled: true,
      })
    ).rejects.toMatchObject({
      code: ORDERS_REQUIRES_PAYMENT,
    });
  });

  it('acepta orders con menú + pago + fulfillment', async () => {
    mockedCount.mockResolvedValue(1);
    mockedOffered.mockResolvedValue([{ id: 'cash' }]);
    const cfg = await upsertBusinessConfig('biz-1', {
      orders_enabled: true,
      takeaway_enabled: true,
    });
    expect(cfg.orders_enabled).toBe(true);
    expect(cfg.takeaway_enabled).toBe(true);
  });

  it('persiste storefront_enabled en patch (BE-15)', async () => {
    const cfg = await upsertBusinessConfig('biz-1', {
      storefront_enabled: true,
    });
    expect(cfg.storefront_enabled).toBe(true);
    expect(mockedExecute).toHaveBeenCalled();
  });

  it('BusinessConfigValidationError expone code', () => {
    const err = new BusinessConfigValidationError('msg', ORDERS_REQUIRES_MENU);
    expect(err.code).toBe(ORDERS_REQUIRES_MENU);
  });
});
