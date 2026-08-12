import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderStatus } from '@prisma/client';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    orders: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    draft_order: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    draft_order_item: {
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        draft_order_item: { deleteMany: vi.fn() },
        draft_order: { update: vi.fn() },
      })
    ),
  },
}));

vi.mock('../../socket/adminSocket', () => ({
  emitAdminOrderStatusChanged: vi.fn(),
}));

vi.mock('../../repositories', () => ({
  createConversationMessage: vi.fn().mockResolvedValue(undefined),
  updateConversationLastMessageAt: vi.fn().mockResolvedValue(undefined),
  patchConversationMetadata: vi.fn().mockResolvedValue(undefined),
  omitConversationMetadataKeys: vi.fn().mockResolvedValue(undefined),
  findBusinessByPhoneNumberId: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  createOrGetOpenConversation: vi.fn(),
  findOrCreateConversationState: vi.fn(),
}));

vi.mock('../orderSessionReset.service', () => ({
  clearOrderSessionAfterCancel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../productQuery/utils', () => ({
  formatBotUserMessage: (title: string, emoji: string, body: string) =>
    `${emoji} ${title}\n${body}`,
}));

import { buildCancelOrderMessage } from '../order.service';
import { prisma } from '../../lib/prisma';
import { emitAdminOrderStatusChanged } from '../../socket/adminSocket';
import {
  clearOrderSessionAfterCancel,
} from '../orderSessionReset.service';
import {
  patchConversationMetadata,
  omitConversationMetadataKeys,
} from '../../repositories';

const CONVERSATION = { id: 'conv-1' } as never;
const ORDER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('buildCancelOrderMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('solo draft → cancela draft y borra Facts de checkout', async () => {
    vi.mocked(prisma.orders.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({ id: 'draft-1' } as never);
    const txUpdate = vi.fn();
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        draft_order_item: { deleteMany: vi.fn() },
        draft_order: { update: txUpdate },
      })
    );

    const result = await buildCancelOrderMessage(CONVERSATION, 'biz-1', '+54911');

    expect(typeof result).toBe('string');
    expect(result as string).toMatch(/carrito|cancelado/i);
    expect(clearOrderSessionAfterCancel).toHaveBeenCalledWith('conv-1');
    expect(emitAdminOrderStatusChanged).not.toHaveBeenCalled();
    expect(prisma.orders.update).not.toHaveBeenCalled();
    expect(txUpdate).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: expect.objectContaining({
        status: 'cancelled',
        fulfillment_type: null,
        payment_method: null,
        delivery_fee: null,
      }),
    });
  });

  it('solo orden creada → cancela y notifica admin con mensaje', async () => {
    vi.mocked(prisma.orders.findFirst).mockResolvedValue({
      id: ORDER_ID,
      business_id: 'biz-1',
      status: OrderStatus.placed,
    } as never);
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(null as never);

    const result = await buildCancelOrderMessage(CONVERSATION, 'biz-1', '+54911');

    expect(typeof result).toBe('string');
    expect(prisma.orders.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ORDER_ID },
        data: { status: OrderStatus.cancelled },
      })
    );
    expect(emitAdminOrderStatusChanged).toHaveBeenCalledWith(
      'biz-1',
      expect.objectContaining({
        orderId: ORDER_ID,
        status: OrderStatus.cancelled,
        message: expect.stringMatching(/canceló el pedido/i),
        orderRef: expect.any(String),
      })
    );
    expect(clearOrderSessionAfterCancel).toHaveBeenCalledWith('conv-1');
  });

  it('ambos sin target → desambigua con botones y no muta', async () => {
    vi.mocked(prisma.orders.findFirst).mockResolvedValue({
      id: ORDER_ID,
      business_id: 'biz-1',
      status: OrderStatus.preparing,
    } as never);
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({ id: 'draft-1' } as never);

    const result = await buildCancelOrderMessage(CONVERSATION, 'biz-1', '+54911');

    expect(typeof result).toBe('object');
    expect(result).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'button',
        action: {
          buttons: expect.arrayContaining([
            expect.objectContaining({
              reply: expect.objectContaining({ id: 'CANCEL_TARGET:draft' }),
            }),
            expect.objectContaining({
              reply: expect.objectContaining({ id: 'CANCEL_TARGET:order' }),
            }),
          ]),
        },
      },
    });
    expect(patchConversationMetadata).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        pending_cancel_disambiguation: expect.objectContaining({ orderId: ORDER_ID }),
      })
    );
    expect(prisma.orders.update).not.toHaveBeenCalled();
    expect(emitAdminOrderStatusChanged).not.toHaveBeenCalled();
  });

  it('ambos con target order → cancela orden + admin; no wipe (draft vivo)', async () => {
    vi.mocked(prisma.orders.findFirst).mockResolvedValue({
      id: ORDER_ID,
      business_id: 'biz-1',
      status: OrderStatus.placed,
    } as never);
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({ id: 'draft-1' } as never);

    await buildCancelOrderMessage(CONVERSATION, 'biz-1', '+54911', { target: 'order' });

    expect(prisma.orders.update).toHaveBeenCalled();
    expect(emitAdminOrderStatusChanged).toHaveBeenCalled();
    // El carrito sigue activo: no reiniciar party/pendings del draft.
    expect(clearOrderSessionAfterCancel).not.toHaveBeenCalled();
    expect(omitConversationMetadataKeys).toHaveBeenCalledWith(
      'conv-1',
      expect.arrayContaining(['pending_cancel_disambiguation'])
    );
  });

  it('ambos con target draft → solo cancela draft', async () => {
    vi.mocked(prisma.orders.findFirst).mockResolvedValue({
      id: ORDER_ID,
      business_id: 'biz-1',
      status: OrderStatus.placed,
    } as never);
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({ id: 'draft-1' } as never);

    await buildCancelOrderMessage(CONVERSATION, 'biz-1', '+54911', {
      payloadId: 'CANCEL_TARGET:draft',
    });

    expect(clearOrderSessionAfterCancel).toHaveBeenCalled();
    expect(prisma.orders.update).not.toHaveBeenCalled();
    expect(emitAdminOrderStatusChanged).not.toHaveBeenCalled();
  });

  it('nada para cancelar', async () => {
    vi.mocked(prisma.orders.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(null as never);

    const result = await buildCancelOrderMessage(CONVERSATION, 'biz-1', '+54911');
    expect(result as string).toMatch(/Nada para cancelar/i);
  });
});
