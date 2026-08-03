/**
 * Tests de la adhesión de la referencia de Embajador al pedido dentro de
 * `createOrderFromDraft` (checkout.service.ts): copia el código vigente a
 * `orders.ambassador_public_code` y borra `ambassador_ref` de metadata;
 * descarta referencias expiradas (TTL).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    customer_address: {
      findFirst: vi.fn(),
    },
    conversation_state: {
      findUnique: vi.fn(),
    },
    orders: {
      create: vi.fn(),
    },
  },
}));

vi.mock('../../socket/adminSocket', () => ({
  emitAdminOrderCreated: vi.fn(),
}));

vi.mock('../deliveryFee.service', () => ({
  resolveDeliveryContext: vi.fn().mockResolvedValue({
    deliveryFee: 0,
    minOrderAmount: 0,
    zoneName: null,
    zoneId: null,
    estimatedMinutes: null,
  }),
}));

vi.mock('../../repositories/conversationState.repository', () => ({
  omitConversationMetadataKeys: vi.fn(),
}));

vi.mock('../../repositories', () => ({
  closeConversation: vi.fn(),
  createOrGetOpenConversation: vi.fn(),
  findBusinessByPhoneNumberId: vi.fn(),
  findOrCreateConversationState: vi.fn(),
  findOrCreateCustomer: vi.fn(),
}));

import { prisma } from '../../lib/prisma';
import { omitConversationMetadataKeys } from '../../repositories/conversationState.repository';
import { createOrderFromDraft } from '../checkout.service';
import { AMBASSADOR_REF_TTL_MS } from '../ambassador/referralCode';

const mockedDraftFindFirst = prisma.draft_order.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedDraftUpdateMany = prisma.draft_order.updateMany as unknown as ReturnType<typeof vi.fn>;
const mockedConversationStateFindUnique = prisma.conversation_state.findUnique as unknown as ReturnType<
  typeof vi.fn
>;
const mockedOrdersCreate = prisma.orders.create as unknown as ReturnType<typeof vi.fn>;
const mockedOmitKeys = omitConversationMetadataKeys as unknown as ReturnType<typeof vi.fn>;

const BUSINESS = { id: 'biz-1', currency_code: 'ARS' } as never;
const CONVERSATION = { id: 'conv-1' } as never;
const CUSTOMER = { id: 'cust-1', phone_number: '5493411234567' } as never;

const DRAFT = {
  id: 'draft-1',
  fulfillment_type: null,
  draft_order_item: [
    {
      product_id: 'item-1',
      quantity: 1,
      unit_price: new Prisma.Decimal(1000),
      list_price: null,
      discount_amount: null,
      notes: null,
      menu_item: {},
    },
  ],
};

describe('createOrderFromDraft — referencia de Embajador', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedDraftFindFirst.mockResolvedValue(DRAFT);
    mockedDraftUpdateMany.mockResolvedValue({ count: 1 });
    mockedOrdersCreate.mockResolvedValue({ id: 'order-1' });
    mockedOmitKeys.mockResolvedValue({});
  });

  it('copia el código vigente a la orden y borra ambassador_ref de metadata', async () => {
    mockedConversationStateFindUnique.mockResolvedValue({
      metadata: { ambassador_ref: { code: 'AMB-7F3K9X', validatedAt: new Date().toISOString() } },
    });

    await createOrderFromDraft(BUSINESS, CONVERSATION, CUSTOMER);

    expect(mockedOrdersCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ambassador_public_code: 'AMB-7F3K9X' }),
      })
    );
    expect(mockedOmitKeys).toHaveBeenCalledWith('conv-1', ['ambassador_ref']);
  });

  it('descarta la referencia si superó el TTL: no la adhiere a la orden (pero sí limpia la clave vieja)', async () => {
    const expiredAt = new Date(Date.now() - AMBASSADOR_REF_TTL_MS - 1000).toISOString();
    mockedConversationStateFindUnique.mockResolvedValue({
      metadata: { ambassador_ref: { code: 'AMB-7F3K9X', validatedAt: expiredAt } },
    });

    await createOrderFromDraft(BUSINESS, CONVERSATION, CUSTOMER);

    expect(mockedOrdersCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ambassador_public_code: null }),
      })
    );
    expect(mockedOmitKeys).toHaveBeenCalledWith('conv-1', ['ambassador_ref']);
  });

  it('sin referencia en metadata, no adhiere código ni llama a limpiar', async () => {
    mockedConversationStateFindUnique.mockResolvedValue({ metadata: {} });

    await createOrderFromDraft(BUSINESS, CONVERSATION, CUSTOMER);

    expect(mockedOrdersCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ambassador_public_code: null }),
      })
    );
    expect(mockedOmitKeys).not.toHaveBeenCalled();
  });
});
