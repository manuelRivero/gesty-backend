/**
 * Fase 9, Tarea 9.1 (PLAN-ACCION-COMPROBANTES-CIERRE.md), D9: aviso al
 * cliente cuando el admin aprueba o rechaza un comprobante de transferencia.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    orders: { findFirst: vi.fn() },
  },
}));

vi.mock('../orderStatusNotification.service', () => ({
  sendCustomerWhatsAppNotification: vi.fn(),
  shortOrderRef: (orderId: string) => orderId.replace(/-/g, '').slice(0, 8).toUpperCase(),
}));

import { prisma } from '../../lib/prisma';
import { sendCustomerWhatsAppNotification } from '../orderStatusNotification.service';
import { notifyCustomerPaymentProofReviewed } from '../paymentProofNotification.service';

const mockedOrdersFindFirst = prisma.orders.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedSend = sendCustomerWhatsAppNotification as unknown as ReturnType<typeof vi.fn>;

describe('notifyCustomerPaymentProofReviewed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedOrdersFindFirst.mockResolvedValue({
      conversation_id: 'conv-1',
      customer: { phone_number: '5493410000000' },
    });
    mockedSend.mockResolvedValue({ sent: true });
  });

  it('aprobado: envía un mensaje que confirma el pago', async () => {
    await notifyCustomerPaymentProofReviewed({
      businessId: 'biz-1',
      orderId: 'order-1',
      decision: 'approve',
    });

    expect(mockedSend).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: 'biz-1',
        customerPhone: '5493410000000',
        conversationId: 'conv-1',
        body: expect.stringContaining('Confirmamos tu pago'),
      })
    );
  });

  it('rechazado: el mensaje no incluye ni review_note ni el detalle de los checks', async () => {
    await notifyCustomerPaymentProofReviewed({
      businessId: 'biz-1',
      orderId: 'order-1',
      decision: 'reject',
    });

    const sentBody = mockedSend.mock.calls[0][0].body as string;
    expect(sentBody).not.toMatch(/monto|destino|fail|unknown|pass/i);
    expect(sentBody).toContain('Revisá tu comprobante');
  });

  it('devuelve sent:false sin lanzar si la orden no existe (aislamiento por business_id)', async () => {
    mockedOrdersFindFirst.mockResolvedValueOnce(null);

    const result = await notifyCustomerPaymentProofReviewed({
      businessId: 'biz-1',
      orderId: 'order-de-otro-negocio',
      decision: 'approve',
    });

    expect(result).toEqual({ sent: false, reason: 'Orden no encontrada' });
    expect(mockedSend).not.toHaveBeenCalled();
  });
});
