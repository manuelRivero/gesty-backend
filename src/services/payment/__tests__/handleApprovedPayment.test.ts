/**
 * Tests de la corrección P0 sobre `handleApprovedPayment` (payment.service.ts):
 * - La creación de la orden y la actualización del `payment_intent` corren
 *   sobre el MISMO `tx` (transacción real, no la `$transaction` que ignoraba
 *   su propio cliente transaccional).
 * - Un webhook repetido/concurrente para el mismo pago no crea una segunda
 *   orden ni reenvía las notificaciones de confirmación.
 *
 * Son pruebas unitarias con Prisma y `createOrderFromDraft` mockeados:
 * demuestran que ambas escrituras se emiten contra el mismo `tx` y que la
 * relectura bajo lock corta el camino si ya fue procesado. La garantía real
 * de atomicidad (rollback si una de las dos escrituras falla) depende de
 * Postgres y no puede demostrarse con mocks — ver nota al final.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderPaymentStatus } from '@prisma/client';

vi.mock('../../../lib/prisma', () => {
  const prismaMock: Record<string, unknown> = {
    payment_intent: { findUnique: vi.fn(), update: vi.fn() },
    customer: { findFirst: vi.fn() },
    conversation: { findFirst: vi.fn() },
    $executeRaw: vi.fn().mockResolvedValue(undefined),
  };
  prismaMock.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(prismaMock));
  return { prisma: prismaMock };
});

vi.mock('../../checkout.service', () => ({
  createOrderFromDraft: vi.fn(),
  acquireOrderCreateLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../socket/adminSocket', () => ({
  emitAdminOrderPaymentStatusChanged: vi.fn(),
}));

vi.mock('../../ambassador/ambassadorSale.service', () => ({
  notifyAmbassadorSaleIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../businessConfig.service', () => ({
  getBusinessConfig: vi.fn().mockResolvedValue({ external_delivery_enabled: false }),
}));

vi.mock('../messageHelpers', () => ({
  sendTextMessageNoCtx: vi.fn().mockResolvedValue(undefined),
  sendImageMessageNoCtx: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from '../../../lib/prisma';
import { acquireOrderCreateLock, createOrderFromDraft } from '../../checkout.service';
import { sendTextMessageNoCtx } from '../messageHelpers';
import { handleApprovedPayment } from '../payment.service';

const mockedFindUniqueIntent = prisma.payment_intent.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedUpdateIntent = prisma.payment_intent.update as unknown as ReturnType<typeof vi.fn>;
const mockedCustomerFindFirst = prisma.customer.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedConversationFindFirst = prisma.conversation.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedTransaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;
const mockedAcquireLock = acquireOrderCreateLock as unknown as ReturnType<typeof vi.fn>;
const mockedCreateOrderFromDraft = createOrderFromDraft as unknown as ReturnType<typeof vi.fn>;
const mockedSendText = sendTextMessageNoCtx as unknown as ReturnType<typeof vi.fn>;

const BUSINESS = { id: 'biz-1', whatsapp_phone_id: 'phone-1', currency_code: 'ARS' };
const DRAFT = { id: 'draft-1', customer_phone: '5493411234567', status: 'active', business: BUSINESS };
const INTENT_PENDING = {
  id: 'intent-1',
  status: 'pending',
  promotion_snapshot: null,
  draft_order: DRAFT,
};
const CUSTOMER = { id: 'cust-1', phone_number: '5493411234567' };
const CONVERSATION = { id: 'conv-1' };

describe('handleApprovedPayment — atomicidad e idempotencia', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTransaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
    mockedCustomerFindFirst.mockResolvedValue(CUSTOMER);
    mockedConversationFindFirst.mockResolvedValue(CONVERSATION);
    mockedCreateOrderFromDraft.mockResolvedValue({
      orderId: 'order-1',
      total: 8000,
      qrDataUrl: 'data:image/png;base64,xxx',
    });
  });

  it('crea la orden y actualiza el intent sobre el mismo `tx`', async () => {
    mockedFindUniqueIntent
      .mockResolvedValueOnce(INTENT_PENDING) // lectura inicial (fuera del lock)
      .mockResolvedValueOnce({ ...INTENT_PENDING }); // relectura bajo lock

    await handleApprovedPayment('intent-1', 'mp-payment-1', {} as never);

    expect(mockedAcquireLock).toHaveBeenCalledWith(prisma, 'biz-1', '5493411234567');
    // `createOrderFromDraft` debe recibir el `tx` de la transacción, no `undefined`.
    expect(mockedCreateOrderFromDraft).toHaveBeenCalledWith(
      BUSINESS,
      CONVERSATION,
      CUSTOMER,
      expect.objectContaining({ paymentStatus: OrderPaymentStatus.paid, paymentMethod: 'online' }),
      prisma
    );
    expect(mockedUpdateIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'intent-1' },
        data: expect.objectContaining({ status: 'approved', order_id: 'order-1' }),
      })
    );
    expect(mockedSendText).toHaveBeenCalled();
  });

  it('webhook repetido: si bajo el lock el intent ya está aprobado, no crea otra orden ni reenvía notificaciones', async () => {
    mockedFindUniqueIntent
      .mockResolvedValueOnce(INTENT_PENDING) // lectura inicial: todavía pending
      .mockResolvedValueOnce({ ...INTENT_PENDING, status: 'approved' }); // bajo el lock: otra ejecución ya lo aprobó

    await handleApprovedPayment('intent-1', 'mp-payment-1', {} as never);

    expect(mockedCreateOrderFromDraft).not.toHaveBeenCalled();
    expect(mockedUpdateIntent).not.toHaveBeenCalled();
    expect(mockedSendText).not.toHaveBeenCalled();
  });

  it('corta temprano (antes del lock) si la lectura inicial ya muestra el intent aprobado', async () => {
    mockedFindUniqueIntent.mockResolvedValueOnce({ ...INTENT_PENDING, status: 'approved' });

    await handleApprovedPayment('intent-1', 'mp-payment-1', {} as never);

    expect(mockedTransaction).not.toHaveBeenCalled();
    expect(mockedCreateOrderFromDraft).not.toHaveBeenCalled();
  });
});

/**
 * LIMITACIÓN CONOCIDA: con mocks solo se demuestra que ambas escrituras
 * (orden + intent) se emiten sobre el mismo `tx` y que la relectura bajo
 * lock corta el camino en un reintento. Que Postgres efectivamente revierta
 * ambas escrituras si una falla (atomicidad real) o que el advisory lock
 * bloquee una segunda transacción concurrente requiere una prueba de
 * integración contra una base real, fuera del alcance de esta tanda.
 */
