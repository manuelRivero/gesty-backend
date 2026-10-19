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

vi.mock('../humanIntentReconciliation.service', () => ({
  closeOrderDomainHumanIntents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../productResolution.service', () => ({
  expireOpenProductResolutions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../storefrontOrderPush.service', () => ({
  scheduleStorefrontOrderPush: vi.fn(),
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
import { closeOrderDomainHumanIntents } from '../humanIntentReconciliation.service';
import { expireOpenProductResolutions } from '../productResolution.service';
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
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        draft_order_item: { deleteMany: vi.fn() },
        draft_order: { update: txUpdate },
      })
    ) as never);

    const result = await buildCancelOrderMessage(CONVERSATION, 'biz-1', '+54911');

    expect(typeof result).toBe('string');
    expect(result as string).toMatch(/carrito|cancelado/i);
    expect(clearOrderSessionAfterCancel).toHaveBeenCalledWith('conv-1');
    expect(closeOrderDomainHumanIntents).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      reason: 'cancelled',
      reference: 'draft-1',
    });
    expect(expireOpenProductResolutions).toHaveBeenCalledWith('conv-1');
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
    expect(closeOrderDomainHumanIntents).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      reason: 'cancelled',
      reference: ORDER_ID,
    });
    expect(expireOpenProductResolutions).toHaveBeenCalledWith('conv-1');
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
        pendingTipables: expect.objectContaining({
          management: ['CANCEL_TARGET_DRAFT', 'CANCEL_TARGET_ORDER'],
        }),
      })
    );
    expect(prisma.orders.update).not.toHaveBeenCalled();
    expect(emitAdminOrderStatusChanged).not.toHaveBeenCalled();
    // Todavía no se canceló nada (se está preguntando qué cancelar): ningún
    // HumanIntent de dominio pedido debe tocarse en esta rama.
    expect(closeOrderDomainHumanIntents).not.toHaveBeenCalled();
    expect(expireOpenProductResolutions).not.toHaveBeenCalled();
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
    // El PEDIR que sigue armando el draft vivo NO debe tocarse: cancelar
    // solo la orden ya confirmada no es cancelar el pedido en curso.
    expect(closeOrderDomainHumanIntents).not.toHaveBeenCalled();
    expect(expireOpenProductResolutions).not.toHaveBeenCalled();
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
    expect(closeOrderDomainHumanIntents).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      reason: 'cancelled',
      reference: 'draft-1',
    });
    expect(prisma.orders.update).not.toHaveBeenCalled();
    expect(emitAdminOrderStatusChanged).not.toHaveBeenCalled();
  });

  it('nada para cancelar → igual limpia la sesión (mode/shortlist/cola de un pedido anterior)', async () => {
    vi.mocked(prisma.orders.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(null as never);

    const result = await buildCancelOrderMessage(CONVERSATION, 'biz-1', '+54911');
    expect(result as string).toMatch(/Nada para cancelar/i);
    expect(clearOrderSessionAfterCancel).toHaveBeenCalledWith('conv-1');
    // Sin draft/orden que cancelar, igual puede haber quedado un PEDIR
    // obsoleto de una sesión anterior (el bug que originó esta auditoría):
    // se cierra igual, sin reference porque no hay draft/orden concreto.
    expect(closeOrderDomainHumanIntents).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      reason: 'cancelled',
      reference: undefined,
    });
    expect(expireOpenProductResolutions).toHaveBeenCalledWith('conv-1');
  });

  it('idempotencia: cancelar dos veces seguidas (sin nada vivo la segunda) no falla ni duplica side-effects raros', async () => {
    vi.mocked(prisma.orders.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({ id: 'draft-1' } as never);
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        draft_order_item: { deleteMany: vi.fn() },
        draft_order: { update: vi.fn() },
      })
    ) as never);

    await buildCancelOrderMessage(CONVERSATION, 'biz-1', '+54911');
    expect(closeOrderDomainHumanIntents).toHaveBeenCalledTimes(1);

    // Segunda cancelación sobre la misma conversación: ya no hay draft vivo
    // (se canceló arriba), así que cae en la rama "nada para cancelar" —
    // igual debe poder ejecutarse sin lanzar.
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(null as never);
    await expect(buildCancelOrderMessage(CONVERSATION, 'biz-1', '+54911')).resolves.toBeTruthy();
    expect(closeOrderDomainHumanIntents).toHaveBeenCalledTimes(2);
  });

  it('[Fix 1] un fallo al cerrar humanIntentState no bloquea la confirmación de cancelación al cliente', async () => {
    vi.mocked(prisma.orders.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({ id: 'draft-1' } as never);
    vi.mocked(prisma.$transaction).mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        draft_order_item: { deleteMany: vi.fn() },
        draft_order: { update: vi.fn() },
      })
    ) as never);
    vi.mocked(closeOrderDomainHumanIntents).mockRejectedValueOnce(
      new Error('boom: humanIntentState lock timeout')
    );
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // El draft YA está cancelado en DB (arriba) para cuando esto corre: la
    // respuesta de negocio al cliente no puede depender de que este
    // side-effect haya salido bien.
    const result = await buildCancelOrderMessage(CONVERSATION, 'biz-1', '+54911');

    expect(result as string).toMatch(/cancelado/i);
    expect(expireOpenProductResolutions).not.toHaveBeenCalled(); // no sigue tras el fallo, pero tampoco lanza
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('reconcileOrderDomainHumanIntentsAfterCancel'),
      expect.objectContaining({ conversationId: 'conv-1' }),
      expect.any(Error)
    );
    consoleErrorSpy.mockRestore();
  });

  it('[Fix 1] un error real de persistencia de la cancelación (no de reconciliación) SÍ se propaga, no se oculta', async () => {
    vi.mocked(prisma.orders.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({ id: 'draft-1' } as never);
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(new Error('DB caída'));

    await expect(buildCancelOrderMessage(CONVERSATION, 'biz-1', '+54911')).rejects.toThrow('DB caída');
    // Nunca se llegó a la reconciliación: la cancelación real falló primero.
    expect(closeOrderDomainHumanIntents).not.toHaveBeenCalled();
  });
});
