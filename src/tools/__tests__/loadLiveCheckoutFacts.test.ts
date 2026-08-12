/**
 * loadLiveCheckoutFacts debe reflejar writes del mismo turno (nombre/dirección),
 * no el snapshot stale de enrichedCtx / state del grafo.
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

vi.mock('../../repositories/customer.repository', () => ({
  findCustomerById: vi.fn(),
  findDefaultCustomerAddress: vi.fn(),
}));

vi.mock('../../services/deliveryFee.service', () => ({
  resolveDeliveryContext: vi.fn(),
}));

vi.mock('../../services/paymentMethods.service', () => ({
  isPaymentMethodOffered: vi.fn(),
}));

vi.mock('../../services/businessConfig.service', () => ({
  getBusinessConfig: vi.fn(),
}));

vi.mock('../../services/intent/intentRefusal.service', () => ({
  incrementRefusalCount: vi.fn(),
}));

import { loadLiveCheckoutFacts } from '../checkout';
import { nextCheckoutStep } from '../../services/checkout/nextCheckoutStep';
import { prisma } from '../../lib/prisma';
import {
  findCustomerById,
  findDefaultCustomerAddress,
} from '../../repositories/customer.repository';

describe('loadLiveCheckoutFacts — snapshot post tool-calls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tras save_customer_name, nextCheckoutStep es payment (no name stale)', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      fulfillment_type: 'TAKE_AWAY',
      payment_method: null,
    } as never);
    // Simula que la tool ya escribió el nombre en BD este turno.
    vi.mocked(findCustomerById).mockResolvedValue({
      id: 'cust-1',
      name: 'Manuel',
    } as never);
    vi.mocked(findDefaultCustomerAddress).mockResolvedValue(null);

    const facts = await loadLiveCheckoutFacts({
      businessId: 'biz-1',
      customerId: 'cust-1',
      customerPhone: '+5491100000000',
    });

    expect(facts.customerName).toBe('Manuel');
    expect(
      nextCheckoutStep(
        {
          fulfillmentType: facts.fulfillmentType,
          hasAddress: facts.hasAddress,
          isInCoverage: facts.isInCoverage,
          customerName: facts.customerName,
          paymentMethod: facts.paymentMethod,
        },
        { deliveryEnabled: true, takeawayEnabled: true }
      )
    ).toBe('payment');
  });

  it('sin nombre en BD → step name', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      fulfillment_type: 'TAKE_AWAY',
      payment_method: null,
    } as never);
    vi.mocked(findCustomerById).mockResolvedValue({ id: 'cust-1', name: null } as never);
    vi.mocked(findDefaultCustomerAddress).mockResolvedValue(null);

    const facts = await loadLiveCheckoutFacts({
      businessId: 'biz-1',
      customerId: 'cust-1',
      customerPhone: '+5491100000000',
    });

    expect(
      nextCheckoutStep(
        {
          fulfillmentType: facts.fulfillmentType,
          hasAddress: facts.hasAddress,
          isInCoverage: facts.isInCoverage,
          customerName: facts.customerName,
          paymentMethod: facts.paymentMethod,
        },
        { deliveryEnabled: true, takeawayEnabled: true }
      )
    ).toBe('name');
  });
});
