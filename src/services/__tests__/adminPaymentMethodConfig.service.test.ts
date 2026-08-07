/**
 * Fase 6, Tarea 6.2 (PLAN-ACCION-COMPROBANTES-CIERRE.md): datos bancarios
 * estructurados en payment_method_config. Cubre solo la normalización nueva
 * (bank_alias/bank_cbu/bank_holder); `instructions` no cambia de comportamiento.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    payment_method_config: {
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../businessConfig.service', () => ({
  getBusinessConfig: vi.fn().mockResolvedValue({ external_delivery_enabled: false }),
}));

vi.mock('../paymentMethods.service', () => ({
  ensureDefaultPaymentMethodConfigs: vi.fn().mockResolvedValue(undefined),
  getPaymentMethodCatalogForAdmin: vi.fn().mockReturnValue([]),
  listActivePaymentMethodSnapshots: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../domain/payment/paymentMethodRules', async () => {
  const actual = await vi.importActual<typeof import('../../domain/payment/paymentMethodRules')>(
    '../../domain/payment/paymentMethodRules'
  );
  return {
    ...actual,
    assertCashAllowedWithExternalDelivery: vi.fn(),
    assertValidPaymentMethodCombination: vi.fn(),
  };
});

import { prisma } from '../../lib/prisma';
import {
  createAdminPaymentMethodConfig,
  updateAdminPaymentMethodConfig,
} from '../adminPaymentMethodConfig.service';

const mockedCreate = prisma.payment_method_config.create as unknown as ReturnType<typeof vi.fn>;
const mockedUpdate = prisma.payment_method_config.update as unknown as ReturnType<typeof vi.fn>;
const mockedFindFirst = prisma.payment_method_config.findFirst as unknown as ReturnType<typeof vi.fn>;

const baseRow = {
  id: 'pmc-1',
  business_id: 'biz-1',
  payment_method: 'transfer',
  label: 'Transferencia',
  adjustment_type: 'FIXED',
  adjustment_value: { toNumber: () => 0 },
  is_surcharge: false,
  is_active: true,
  instructions: null,
  sort_order: 0,
  bank_alias: null,
  bank_cbu: null,
  bank_holder: null,
  created_at: new Date(),
  updated_at: new Date(),
};

describe('adminPaymentMethodConfig.service — datos bancarios (Fase 6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('crear normaliza el CBU (sin espacios/guiones) y el alias (minúsculas)', async () => {
    mockedCreate.mockResolvedValueOnce({
      ...baseRow,
      bank_alias: 'mi.alias.mp',
      bank_cbu: '0000003100010000000001',
      bank_holder: 'Juan Pérez',
    });

    await createAdminPaymentMethodConfig('biz-1', {
      paymentMethod: 'transfer',
      label: 'Transferencia',
      adjustmentType: 'FIXED',
      adjustmentValue: 0,
      isSurcharge: false,
      bankAlias: 'MI.ALIAS.MP',
      bankCbu: '0000-0031-0001-0000000001',
      bankHolder: '  Juan Pérez  ',
    });

    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bank_alias: 'mi.alias.mp',
          bank_cbu: '0000003100010000000001',
          bank_holder: 'Juan Pérez',
        }),
      })
    );
  });

  it('crear sin datos bancarios los deja en null (no rompe el flujo existente)', async () => {
    mockedCreate.mockResolvedValueOnce(baseRow);

    await createAdminPaymentMethodConfig('biz-1', {
      paymentMethod: 'transfer',
      label: 'Transferencia',
      adjustmentType: 'FIXED',
      adjustmentValue: 0,
      isSurcharge: false,
      instructions: 'CBU: 000...',
    });

    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bank_alias: null,
          bank_cbu: null,
          bank_holder: null,
          instructions: 'CBU: 000...',
        }),
      })
    );
  });

  it('actualizar normaliza igual que crear, y no toca instructions si no se manda', async () => {
    mockedFindFirst.mockResolvedValueOnce(baseRow);
    mockedUpdate.mockResolvedValueOnce(baseRow);

    await updateAdminPaymentMethodConfig('biz-1', 'pmc-1', {
      bankAlias: 'Otro.Alias',
      bankCbu: '1111 2222 3333 444444',
    });

    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bank_alias: 'otro.alias',
          bank_cbu: '111122223333444444',
        }),
      })
    );
    expect(mockedUpdate.mock.calls[0][0].data).not.toHaveProperty('instructions');
  });

  it('actualizar con string vacío limpia el campo a null', async () => {
    mockedFindFirst.mockResolvedValueOnce(baseRow);
    mockedUpdate.mockResolvedValueOnce(baseRow);

    await updateAdminPaymentMethodConfig('biz-1', 'pmc-1', {
      bankAlias: '   ',
    });

    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bank_alias: null }),
      })
    );
  });
});
