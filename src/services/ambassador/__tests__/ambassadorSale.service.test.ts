import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    orders: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../../businessConfig.service', () => ({
  getBusinessConfig: vi.fn(),
}));

vi.mock('../../../integrations/ambassadors/client', () => ({
  isAmbassadorsClientConfigured: vi.fn(),
  registerAmbassadorSale: vi.fn(),
}));

import { prisma } from '../../../lib/prisma';
import { getBusinessConfig } from '../../businessConfig.service';
import {
  isAmbassadorsClientConfigured,
  registerAmbassadorSale,
} from '../../../integrations/ambassadors/client';
import { AmbassadorsApiError } from '../../../integrations/ambassadors/types';
import { notifyAmbassadorSaleIfNeeded } from '../ambassadorSale.service';

const mockedFindUnique = prisma.orders.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedUpdate = prisma.orders.update as unknown as ReturnType<typeof vi.fn>;
const mockedGetBusinessConfig = getBusinessConfig as unknown as ReturnType<typeof vi.fn>;
const mockedIsConfigured = isAmbassadorsClientConfigured as unknown as ReturnType<typeof vi.fn>;
const mockedRegister = registerAmbassadorSale as unknown as ReturnType<typeof vi.fn>;

const PAID_ORDER_WITH_CODE = {
  id: 'order-1',
  business_id: 'biz-1',
  ambassador_public_code: 'AMB-7F3K9X',
  ambassador_notified_at: null,
  payment_status: 'paid',
  total_amount: 1000,
  currency_code: 'ARS',
  customer: { phone_number: '5493411234567', name: 'Juan Pérez' },
};

describe('notifyAmbassadorSaleIfNeeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetBusinessConfig.mockResolvedValue({ ambassadors_enabled: true });
    mockedIsConfigured.mockReturnValue(true);
  });

  it('no notifica si la orden no tiene ambassador_public_code', async () => {
    mockedFindUnique.mockResolvedValueOnce({ ...PAID_ORDER_WITH_CODE, ambassador_public_code: null });

    await notifyAmbassadorSaleIfNeeded('order-1');

    expect(mockedRegister).not.toHaveBeenCalled();
  });

  it('no notifica si ya fue notificada (idempotencia local)', async () => {
    mockedFindUnique.mockResolvedValueOnce({
      ...PAID_ORDER_WITH_CODE,
      ambassador_notified_at: new Date(),
    });

    await notifyAmbassadorSaleIfNeeded('order-1');

    expect(mockedRegister).not.toHaveBeenCalled();
  });

  it('no notifica si el pedido no está pagado', async () => {
    mockedFindUnique.mockResolvedValueOnce({ ...PAID_ORDER_WITH_CODE, payment_status: 'unpaid' });

    await notifyAmbassadorSaleIfNeeded('order-1');

    expect(mockedRegister).not.toHaveBeenCalled();
  });

  it('no notifica si el business tiene ambassadors_enabled=false', async () => {
    mockedFindUnique.mockResolvedValueOnce(PAID_ORDER_WITH_CODE);
    mockedGetBusinessConfig.mockResolvedValueOnce({ ambassadors_enabled: false });

    await notifyAmbassadorSaleIfNeeded('order-1');

    expect(mockedRegister).not.toHaveBeenCalled();
  });

  it('notifica y marca ambassador_notified_at cuando todo procede (commissionCreated true)', async () => {
    mockedFindUnique.mockResolvedValueOnce(PAID_ORDER_WITH_CODE);
    mockedRegister.mockResolvedValueOnce({ success: true, commissionCreated: true });

    await notifyAmbassadorSaleIfNeeded('order-1');

    expect(mockedRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        publicCode: 'AMB-7F3K9X',
        orderId: 'order-1',
        customer: { phone: '+5493411234567', name: 'Juan Pérez' },
      })
    );
    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-1' },
        data: expect.objectContaining({ ambassador_notified_at: expect.any(Date) }),
      })
    );
  });

  it('commissionCreated: false es un éxito (no un error) y también marca notified_at', async () => {
    mockedFindUnique.mockResolvedValueOnce(PAID_ORDER_WITH_CODE);
    mockedRegister.mockResolvedValueOnce({
      success: true,
      commissionCreated: false,
      reason: 'FIRST_PURCHASE_ALREADY_USED',
    });

    await notifyAmbassadorSaleIfNeeded('order-1');

    expect(mockedUpdate).toHaveBeenCalled();
  });

  it('409 (ya notificado del lado de Domingo Sabrosón) se trata como éxito idempotente', async () => {
    mockedFindUnique.mockResolvedValueOnce(PAID_ORDER_WITH_CODE);
    mockedRegister.mockRejectedValueOnce(new AmbassadorsApiError('conflict', 409));

    await notifyAmbassadorSaleIfNeeded('order-1');

    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ambassador_notified_at: expect.any(Date) }) })
    );
  });

  it('400/403/404 es un fallo permanente: marca notified_at para no reintentar', async () => {
    mockedFindUnique.mockResolvedValueOnce(PAID_ORDER_WITH_CODE);
    mockedRegister.mockRejectedValueOnce(new AmbassadorsApiError('not found', 404));

    await notifyAmbassadorSaleIfNeeded('order-1');

    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ambassador_notified_at: expect.any(Date) }) })
    );
  });

  it('500 es un fallo transitorio: NO marca notified_at (permite reintento futuro)', async () => {
    mockedFindUnique.mockResolvedValueOnce(PAID_ORDER_WITH_CODE);
    mockedRegister.mockRejectedValueOnce(new AmbassadorsApiError('internal error', 500));

    await notifyAmbassadorSaleIfNeeded('order-1');

    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it('nunca lanza, incluso ante un error inesperado', async () => {
    mockedFindUnique.mockRejectedValueOnce(new Error('db down'));

    await expect(notifyAmbassadorSaleIfNeeded('order-1')).resolves.toBeUndefined();
  });
});
