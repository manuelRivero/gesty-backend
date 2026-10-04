import { describe, expect, it, vi } from 'vitest';

const findOrCreateConversationStateMock = vi.fn().mockResolvedValue({
  metadata: { peopleCount: 4 },
});

vi.mock('../../repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories')>();
  return {
    ...actual,
    findOrCreateConversationState: (...args: unknown[]) =>
      findOrCreateConversationStateMock(...args),
  };
});

vi.mock('../../services/ordersCapabilityGate.service', () => ({
  assertCanOrder: vi.fn().mockResolvedValue({ ok: true }),
}));

import { presentProductCtaTool } from '../index';

const PRODUCT_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
];

const config = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'customer-1',
    customerPhone: '+5491100000000',
    conversationId: 'conversation-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

describe('present_product_cta schema', () => {
  it('acepta SELECT_FROM_LIST sin primaryLabel y descarta uno largo', async () => {
    const withoutLabel = presentProductCtaTool.schema.safeParse({
      primaryKind: 'SELECT_FROM_LIST',
      productIds: PRODUCT_IDS,
    });
    const withLongLabel = presentProductCtaTool.schema.safeParse({
      primaryKind: 'SELECT_FROM_LIST',
      productIds: PRODUCT_IDS,
      primaryLabel: 'Elegí el ceviche que querés',
    });

    expect(withoutLabel.success).toBe(true);
    expect(withLongLabel.success).toBe(true);

    const noLabelResult = await presentProductCtaTool.invoke({
      primaryKind: 'SELECT_FROM_LIST',
      productIds: PRODUCT_IDS,
    }, config);
    const longLabelResult = await presentProductCtaTool.invoke({
      primaryKind: 'SELECT_FROM_LIST',
      productIds: PRODUCT_IDS,
      primaryLabel: 'Elegí el ceviche que querés',
    }, config);

    expect(JSON.parse(String(noLabelResult))).toMatchObject({
      signal: 'present_product_cta',
      primaryKind: 'SELECT_FROM_LIST',
      productIds: PRODUCT_IDS,
      primaryLabel: null,
    });
    expect(JSON.parse(String(longLabelResult))).toMatchObject({
      signal: 'present_product_cta',
      primaryKind: 'SELECT_FROM_LIST',
      productIds: PRODUCT_IDS,
      primaryLabel: null,
    });
  });

  it('mantiene el límite de 20 para labels de CTA con botón', async () => {
    const valid = presentProductCtaTool.schema.safeParse({
      primaryKind: 'ADD_ITEM',
      productId: PRODUCT_IDS[0],
      primaryLabel: 'Agregar 🛒',
    });

    expect(valid.success).toBe(true);

    await expect(presentProductCtaTool.invoke({
      primaryKind: 'ADD_ITEM',
      productId: PRODUCT_IDS[0],
      primaryLabel: 'x'.repeat(21),
    }, config)).rejects.toThrow();

    const validResult = await presentProductCtaTool.invoke({
      primaryKind: 'ADD_ITEM',
      productId: PRODUCT_IDS[0],
      primaryLabel: 'Agregar 🛒',
    }, config);
    expect(JSON.parse(String(validResult))).toMatchObject({
      signal: 'present_product_cta',
      primaryLabel: 'Agregar 🛒',
    });
  });
});