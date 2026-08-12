/**
 * Gate duro de save_payment_method / setDraftPaymentMethod:
 * no persiste el Fact si nextCheckoutStep no es payment (faltan
 * fulfillment / address / name).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../../services/paymentMethods.service', () => ({
  isPaymentMethodOffered: vi.fn(),
}));

vi.mock('../../services/businessConfig.service', () => ({
  getBusinessConfig: vi.fn(),
}));

vi.mock('../../repositories/customer.repository', () => ({
  findCustomerById: vi.fn(),
  findDefaultCustomerAddress: vi.fn(),
}));

vi.mock('../../services/deliveryFee.service', () => ({
  resolveDeliveryContext: vi.fn(),
}));

vi.mock('../../repositories/conversationState.repository', () => ({
  patchConversationMetadata: vi.fn(),
}));

vi.mock('../../services/intent/intentRefusal.service', () => ({
  incrementRefusalCount: vi.fn(),
}));

import { setDraftPaymentMethod, savePaymentMethodTool } from '../checkout';
import { prisma } from '../../lib/prisma';
import { isPaymentMethodOffered } from '../../services/paymentMethods.service';
import { getBusinessConfig } from '../../services/businessConfig.service';
import {
  findCustomerById,
  findDefaultCustomerAddress,
} from '../../repositories/customer.repository';
import { resolveDeliveryContext } from '../../services/deliveryFee.service';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

const BIZ_CONFIG = {
  delivery_enabled: true,
  takeaway_enabled: true,
  external_delivery_enabled: false,
};

describe('setDraftPaymentMethod — gate de prerequisitos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBusinessConfig).mockResolvedValue(BIZ_CONFIG as never);
    vi.mocked(isPaymentMethodOffered).mockResolvedValue(true);
  });

  it('rechaza y no persiste si falta el nombre', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      id: 'draft-1',
      fulfillment_type: 'TAKE_AWAY',
      payment_method: null,
    } as never);
    vi.mocked(findCustomerById).mockResolvedValue({ id: 'cust-1', name: null } as never);
    vi.mocked(findDefaultCustomerAddress).mockResolvedValue(null);

    const result = await setDraftPaymentMethod('biz-1', '+5491100000000', 'cash', {
      customerId: 'cust-1',
    });

    expect(result).toEqual({
      success: false,
      error: 'name_required',
      requiredStep: 'name',
    });
    expect(prisma.draft_order.update).not.toHaveBeenCalled();
  });

  it('rechaza si falta fulfillment', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      id: 'draft-1',
      fulfillment_type: null,
      payment_method: null,
    } as never);
    vi.mocked(findCustomerById).mockResolvedValue({ id: 'cust-1', name: 'Ana' } as never);
    vi.mocked(findDefaultCustomerAddress).mockResolvedValue(null);

    const result = await setDraftPaymentMethod('biz-1', '+5491100000000', 'cash', {
      customerId: 'cust-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('fulfillment_required');
    expect(result.requiredStep).toBe('fulfillment');
    expect(prisma.draft_order.update).not.toHaveBeenCalled();
  });

  it('rechaza si DELIVERY sin dirección', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      id: 'draft-1',
      fulfillment_type: 'DELIVERY',
      payment_method: null,
    } as never);
    vi.mocked(findCustomerById).mockResolvedValue({ id: 'cust-1', name: 'Ana' } as never);
    vi.mocked(findDefaultCustomerAddress).mockResolvedValue(null);

    const result = await setDraftPaymentMethod('biz-1', '+5491100000000', 'online', {
      customerId: 'cust-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('address_required');
    expect(prisma.draft_order.update).not.toHaveBeenCalled();
  });

  it('persiste cuando el draft está listo para payment', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      id: 'draft-1',
      fulfillment_type: 'TAKE_AWAY',
      payment_method: null,
    } as never);
    vi.mocked(findCustomerById).mockResolvedValue({ id: 'cust-1', name: 'Ana' } as never);
    vi.mocked(findDefaultCustomerAddress).mockResolvedValue(null);
    vi.mocked(prisma.draft_order.update).mockResolvedValue({} as never);

    const result = await setDraftPaymentMethod('biz-1', '+5491100000000', 'cash', {
      customerId: 'cust-1',
    });

    expect(result).toEqual({ success: true });
    expect(prisma.draft_order.update).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: { payment_method: 'cash' },
    });
  });
});

describe('save_payment_method tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBusinessConfig).mockResolvedValue(BIZ_CONFIG as never);
    vi.mocked(isPaymentMethodOffered).mockResolvedValue(true);
  });

  it('devuelve name_required estructurado sin signal payment_method_saved', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      id: 'draft-1',
      fulfillment_type: 'TAKE_AWAY',
      payment_method: null,
    } as never);
    vi.mocked(findCustomerById).mockResolvedValue({ id: 'cust-1', name: null } as never);
    vi.mocked(findDefaultCustomerAddress).mockResolvedValue(null);

    const raw = await savePaymentMethodTool.func({ method: 'cash' }, undefined, CONFIG);
    const parsed = JSON.parse(raw) as {
      success: boolean;
      error?: string;
      requiredStep?: string;
      signal?: string;
    };

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('name_required');
    expect(parsed.requiredStep).toBe('name');
    expect(parsed.signal).toBeUndefined();
    expect(prisma.draft_order.update).not.toHaveBeenCalled();
  });

  it('DELIVERY con dirección en cobertura + nombre → success + signal', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      id: 'draft-1',
      fulfillment_type: 'DELIVERY',
      payment_method: null,
    } as never);
    vi.mocked(findCustomerById).mockResolvedValue({ id: 'cust-1', name: 'Ana' } as never);
    vi.mocked(findDefaultCustomerAddress).mockResolvedValue({
      id: 'addr-1',
      street_address: 'Calle 1',
    } as never);
    vi.mocked(resolveDeliveryContext).mockResolvedValue({
      zoneId: 'zone-1',
      deliveryFee: 500,
      minOrderAmount: 0,
      zoneName: 'Centro',
      estimatedMinutes: 40,
    });
    vi.mocked(prisma.draft_order.update).mockResolvedValue({} as never);

    const raw = await savePaymentMethodTool.func({ method: 'transfer' }, undefined, CONFIG);
    const parsed = JSON.parse(raw) as {
      success: boolean;
      paymentMethod?: string;
      signal?: string;
    };

    expect(parsed).toEqual({
      success: true,
      paymentMethod: 'transfer',
      signal: 'payment_method_saved',
    });
  });
});
