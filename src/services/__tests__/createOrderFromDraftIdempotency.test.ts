/**
 * Tests de la corrección P0 sobre `createOrderFromDraft` (checkout.service.ts):
 * - El lock se adquiere siempre antes de releer el estado del draft.
 * - Una segunda confirmación sobre un draft ya convertido no crea otra orden.
 * - `order_item` conserva cantidades, notas, variación, precio y el total/
 *   payment_method de la orden coinciden con lo calculado.
 *
 * Son pruebas unitarias con Prisma mockeado: demuestran la ORQUESTACIÓN
 * (orden de llamadas, qué pasa si la relectura bajo lock ya no encuentra un
 * draft activo), no la garantía real de Postgres de que
 * `pg_advisory_xact_lock` serializa transacciones concurrentes — eso requiere
 * una prueba de integración contra una base real (ver nota al final).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/prisma', () => {
  const prismaMock: Record<string, unknown> = {
    draft_order: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    customer_address: {
      findFirst: vi.fn(),
    },
    conversation_state: {
      findUnique: vi.fn(),
      upsert: vi.fn().mockResolvedValue({}),
    },
    orders: {
      create: vi.fn(),
    },
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  prismaMock.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(prismaMock));
  return { prisma: prismaMock };
});

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

const { closeOrderDomainHumanIntentsMock } = vi.hoisted(() => ({
  closeOrderDomainHumanIntentsMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../humanIntentReconciliation.service', () => ({
  closeOrderDomainHumanIntents: closeOrderDomainHumanIntentsMock,
}));

// `omitConversationMetadataKeys` también se importa desde el barrel
// `../repositories` (así lo hace `pendingOrderLines.service.ts`, usado por
// `reconcileOrderDomainStateAfterCheckout`) — no es el mismo mock que el de
// `conversationState.repository` arriba, hay que declararlo acá también.
vi.mock('../../repositories', () => ({
  closeConversation: vi.fn(),
  createOrGetOpenConversation: vi.fn(),
  findBusinessByPhoneNumberId: vi.fn(),
  findOrCreateConversationState: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  omitConversationMetadataKeys: vi.fn(),
  patchConversationMetadata: vi.fn(),
  mutateConversationMetadata: vi.fn(),
}));

vi.mock('../promotions/resolveCartPromotions', () => ({
  resolveCartPromotions: vi.fn().mockResolvedValue({
    monetaryDiscount: 0,
    freeShipping: false,
    giftItems: [],
    applied: [],
  }),
  promotionSignature: vi.fn().mockReturnValue('no-op-signature'),
}));

vi.mock('../paymentAdjustment.service', () => ({
  resolvePaymentAdjustment: vi.fn().mockResolvedValue({
    adjustmentAmount: 0,
    label: null,
    hasAdjustment: false,
  }),
  listPaymentAdjustmentsForAmount: vi.fn().mockResolvedValue([]),
}));

import { prisma } from '../../lib/prisma';
import { omitConversationMetadataKeys } from '../../repositories';
import { createOrderFromDraft } from '../checkout.service';

const mockedOmitConversationMetadataKeys = omitConversationMetadataKeys as unknown as ReturnType<
  typeof vi.fn
>;

const mockedDraftFindFirst = prisma.draft_order.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedDraftUpdateMany = prisma.draft_order.updateMany as unknown as ReturnType<typeof vi.fn>;
const mockedConversationStateFindUnique = prisma.conversation_state.findUnique as unknown as ReturnType<
  typeof vi.fn
>;
const mockedOrdersCreate = prisma.orders.create as unknown as ReturnType<typeof vi.fn>;
const mockedExecuteRaw = prisma.$executeRaw as unknown as ReturnType<typeof vi.fn>;
const mockedTransaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;

const BUSINESS = { id: 'biz-1', currency_code: 'ARS' } as never;
const CONVERSATION = { id: 'conv-1' } as never;
const CUSTOMER = { id: 'cust-1', phone_number: '5493411234567' } as never;

// Factory (no `structuredClone`: `Prisma.Decimal` no es clonable estructuralmente)
// para que cada test reciba una instancia de draft fresca e independiente.
const freshDraft = () => ({
  id: 'draft-1',
  fulfillment_type: null as null,
  draft_order_item: [
    {
      product_id: 'item-ceviche',
      quantity: 1,
      unit_price: new Prisma.Decimal(5000),
      list_price: null,
      discount_amount: null,
      notes: 'poco picante',
      variation: null as string | null,
      menu_item: {},
    },
    {
      product_id: 'item-papas',
      quantity: 2,
      unit_price: new Prisma.Decimal(1500),
      list_price: null,
      discount_amount: null,
      notes: 'sin cebolla',
      variation: 'Grande',
      menu_item: {},
    },
  ],
});

describe('createOrderFromDraft — lock e idempotencia', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTransaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
    mockedDraftUpdateMany.mockResolvedValue({ count: 1 });
    mockedOrdersCreate.mockResolvedValue({ id: 'order-1' });
    mockedConversationStateFindUnique.mockResolvedValue({ metadata: {} });
  });

  it('adquiere el advisory lock antes de releer el draft (orden de llamadas)', async () => {
    mockedDraftFindFirst.mockResolvedValue(freshDraft());

    await createOrderFromDraft(BUSINESS, CONVERSATION, CUSTOMER);

    // 1 transacción para crear la orden + 1 propia de
    // `expireOpenProductResolutions` (dentro de `reconcileOrderDomainStateAfterCheckout`,
    // que corre después de que la primera ya commiteó).
    expect(mockedTransaction).toHaveBeenCalledTimes(2);
    expect(mockedExecuteRaw).toHaveBeenCalledTimes(1);
    const lockCallOrder = mockedExecuteRaw.mock.invocationCallOrder[0];
    const findFirstCallOrder = mockedDraftFindFirst.mock.invocationCallOrder[0];
    expect(lockCallOrder).toBeLessThan(findFirstCallOrder);
  });

  it('segunda confirmación sobre un draft ya convertido no crea una segunda orden', async () => {
    // 1ra ejecución: hay draft activo.
    mockedDraftFindFirst.mockResolvedValueOnce(freshDraft());
    await createOrderFromDraft(BUSINESS, CONVERSATION, CUSTOMER);
    expect(mockedOrdersCreate).toHaveBeenCalledTimes(1);

    // 2da ejecución (doble confirmación / reintento): bajo el lock, la
    // relectura ya no encuentra un draft `active` (el primero lo convirtió).
    mockedDraftFindFirst.mockResolvedValueOnce(null);
    await expect(createOrderFromDraft(BUSINESS, CONVERSATION, CUSTOMER)).rejects.toThrow('empty_cart');

    expect(mockedOrdersCreate).toHaveBeenCalledTimes(1);
    expect(mockedDraftUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('concurrencia simulada: si la relectura bajo lock ya no encuentra el draft activo, la segunda llamada no escribe nada', async () => {
    // Simula el efecto de la serialización por lock: cuando la primera
    // ejecución ya resolvió y convirtió el draft, cualquier ejecución que
    // relea el estado DESPUÉS (haya o no corrido en paralelo) ve `null`.
    let calls = 0;
    mockedDraftFindFirst.mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? freshDraft() : null;
    });

    const [first, second] = await Promise.allSettled([
      createOrderFromDraft(BUSINESS, CONVERSATION, CUSTOMER),
      createOrderFromDraft(BUSINESS, CONVERSATION, CUSTOMER),
    ]);

    const fulfilled = [first, second].filter((r) => r.status === 'fulfilled');
    const rejected = [first, second].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toBe('empty_cart');
    expect(mockedOrdersCreate).toHaveBeenCalledTimes(1);
  });

  it('propaga el `tx` externo en vez de abrir una transacción propia (camino de Mercado Pago)', async () => {
    mockedDraftFindFirst.mockResolvedValue(freshDraft());
    const externalTx = {
      draft_order: prisma.draft_order,
      customer_address: prisma.customer_address,
      conversation_state: prisma.conversation_state,
      orders: prisma.orders,
      $executeRaw: vi.fn().mockResolvedValue(undefined),
    } as never;

    await createOrderFromDraft(BUSINESS, CONVERSATION, CUSTOMER, {}, externalTx);

    // No debe abrir su propia transacción: el caller (handleApprovedPayment)
    // ya está dentro de una. Con un `tx` externo todavía sin commitear,
    // cerrar el estado conversacional acá (`reconcileOrderDomainStateAfterCheckout`)
    // sería inseguro (ver comentario en checkout.service.ts) — es
    // responsabilidad del caller llamarlo una vez que SU transacción
    // resuelva. Si hubiera corrido, `expireOpenProductResolutions` habría
    // abierto su propia `prisma.$transaction` (el mismo mock) — por eso
    // "no se llamó nunca" alcanza para probar las dos cosas a la vez.
    expect(mockedTransaction).not.toHaveBeenCalled();
    expect(mockedOrdersCreate).toHaveBeenCalledTimes(1);
  });

  it('con transacción propia (sin `tx` externo), cierra el estado conversacional de armado tras commitear', async () => {
    mockedDraftFindFirst.mockResolvedValue(freshDraft());

    await createOrderFromDraft(BUSINESS, CONVERSATION, CUSTOMER);

    // `expireOpenProductResolutions` corrió en una segunda transacción,
    // después de que la de creación de la orden ya resolvió.
    expect(mockedTransaction).toHaveBeenCalledTimes(2);
    // `clearPendingOrderLines` (dentro de `reconcileOrderDomainStateAfterCheckout`)
    // corrió sobre la conversación correcta.
    expect(mockedOmitConversationMetadataKeys).toHaveBeenCalledWith('conv-1', ['pendingOrderLines']);
  });

  it('[Fix 1] un fallo al cerrar humanIntentState tras el checkout NO convierte el resultado en error: la orden ya creada se devuelve igual', async () => {
    mockedDraftFindFirst.mockResolvedValue(freshDraft());
    closeOrderDomainHumanIntentsMock.mockRejectedValueOnce(new Error('boom: humanIntentState lock timeout'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await createOrderFromDraft(BUSINESS, CONVERSATION, CUSTOMER);

    // La orden se creó y se devuelve normalmente — el fallo de reconciliación
    // (un side-effect posterior al commit) nunca debió convertirse en un
    // error genérico para el caller de negocio.
    expect(result.orderId).toBe('order-1');
    expect(mockedOrdersCreate).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('reconcileOrderDomainStateAfterCheckout'),
      expect.objectContaining({ conversationId: 'conv-1', orderId: 'order-1' }),
      expect.any(Error)
    );
    consoleErrorSpy.mockRestore();
  });

  it('[Fix 1] un error real de creación de la orden (no de reconciliación) SÍ se propaga', async () => {
    mockedDraftFindFirst.mockResolvedValue(freshDraft());
    mockedOrdersCreate.mockRejectedValueOnce(new Error('constraint violation'));

    await expect(createOrderFromDraft(BUSINESS, CONVERSATION, CUSTOMER)).rejects.toThrow(
      'constraint violation'
    );
    // Nunca se llegó a reconciliar: la creación de la orden falló primero.
    expect(closeOrderDomainHumanIntentsMock).not.toHaveBeenCalled();
  });

  it('integridad: cantidades, notas y variación de cada línea llegan intactas a `order_item`, y total/payment_method a la orden', async () => {
    mockedDraftFindFirst.mockResolvedValue(freshDraft());

    await createOrderFromDraft(BUSINESS, CONVERSATION, CUSTOMER, { paymentMethod: 'cash' });

    expect(mockedOrdersCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payment_method: 'cash',
          total_amount: expect.anything(),
          order_item: expect.objectContaining({
            create: expect.arrayContaining([
              expect.objectContaining({
                menu_item_id: 'item-ceviche',
                quantity: 1,
                notes: 'poco picante',
                variation: undefined,
              }),
              expect.objectContaining({
                menu_item_id: 'item-papas',
                quantity: 2,
                notes: 'sin cebolla',
                variation: 'Grande',
              }),
            ]),
          }),
        }),
      })
    );

    const createCall = mockedOrdersCreate.mock.calls[0][0];
    const total = createCall.data.total_amount as number;
    // 1 ceviche ($5000) + 2 papas ($1500 c/u) = $8000, sin delivery/ajustes.
    expect(total).toBe(8000);

    // Una nota nunca debe terminar en la línea equivocada.
    const items = createCall.data.order_item.create as Array<{
      menu_item_id: string;
      notes?: string;
    }>;
    const ceviche = items.find((i) => i.menu_item_id === 'item-ceviche');
    const papas = items.find((i) => i.menu_item_id === 'item-papas');
    expect(ceviche?.notes).toBe('poco picante');
    expect(papas?.notes).toBe('sin cebolla');
  });
});

/**
 * LIMITACIÓN CONOCIDA: estas pruebas no pueden demostrar que
 * `pg_advisory_xact_lock` efectivamente bloquea una segunda transacción real
 * mientras la primera sigue abierta (eso es una garantía de Postgres, no de
 * la orquestación en TypeScript). Validar esa garantía requiere una prueba
 * de integración contra una base Postgres real, fuera del alcance de esta
 * tanda de pruebas deterministas.
 */
