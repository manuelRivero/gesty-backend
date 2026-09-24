import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const {
  getActiveProvider,
  verifyMpWebhookSignature,
  fetchMpPayment,
  handleApprovedPayment,
  handleApprovedStorefrontPayment,
  handleRejectedPayment,
  handleRejectedStorefrontPayment,
  findFirst,
} = vi.hoisted(() => ({
  getActiveProvider: vi.fn(),
  verifyMpWebhookSignature: vi.fn(),
  fetchMpPayment: vi.fn(),
  handleApprovedPayment: vi.fn(),
  handleApprovedStorefrontPayment: vi.fn(),
  handleRejectedPayment: vi.fn(),
  handleRejectedStorefrontPayment: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    payment_intent: { findFirst },
    draft_order: { findUnique: vi.fn() },
    business: { findUnique: vi.fn() },
  },
}));

vi.mock('../../../services/payment/paymentProvider.repository', () => ({
  getActiveProvider,
}));

vi.mock('../../../services/payment/mercadoPago.service', () => ({
  verifyMpWebhookSignature,
  fetchMpPayment,
}));

vi.mock('../../../services/payment/payment.service', () => ({
  handleApprovedPayment,
  handleApprovedStorefrontPayment,
  handleRejectedPayment,
  handleRejectedStorefrontPayment,
}));

vi.mock('../../../services/payment/messageHelpers', () => ({
  sendTextMessageNoCtx: vi.fn(),
}));

import { mercadoPagoWebhookHandler } from '../mercadoPagoWebhook.controller';

function fakeRes(): Response {
  return {
    sendStatus: vi.fn(),
  } as unknown as Response;
}

function paymentReq(): Request {
  return {
    query: {
      business_id: 'e89dfb88-a409-4818-a01e-37d7d5ba2e11',
      'data.id': '180569678812',
    },
    headers: {
      'x-signature': 'ts=1790204217,v1=0903b87e5c627f66d7234bb5064c2f23be8b81180c22208692e6aea130eeb09b',
      'x-request-id': '08302f96-e85a-45d8-8181-a958cf9d6117',
    },
    body: {
      type: 'payment',
      action: 'payment.created',
      data: { id: '180569678812' },
    },
  } as unknown as Request;
}

describe('mercadoPagoWebhookHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveProvider.mockResolvedValue({
      id: 'prov-1',
      accessToken: 'APP_USR-test',
      webhookSecret: '586eafa31f778c368c79c49522f010fce23b6a6bcd181145c040b455fa1d1eb2',
      isSandbox: false,
    });
    verifyMpWebhookSignature.mockReturnValue(false);
    fetchMpPayment.mockResolvedValue({
      status: 'approved',
      external_reference: '8afdee3f-e9c5-497b-b5f1-ed7bded61045',
    });
    findFirst.mockResolvedValue({
      id: 'intent-1',
      order_id: null,
      draft_order_id: '8afdee3f-e9c5-497b-b5f1-ed7bded61045',
    });
    handleApprovedPayment.mockResolvedValue(undefined);
  });

  it('con HMAC inválido igual consulta el pago y confirma el draft si MP lo da approved', async () => {
    await mercadoPagoWebhookHandler(paymentReq(), fakeRes());

    expect(fetchMpPayment).toHaveBeenCalledWith('180569678812', 'APP_USR-test');
    expect(handleApprovedPayment).toHaveBeenCalledWith(
      'intent-1',
      '180569678812',
      expect.objectContaining({
        status: 'approved',
        external_reference: '8afdee3f-e9c5-497b-b5f1-ed7bded61045',
      })
    );
    expect(handleApprovedStorefrontPayment).not.toHaveBeenCalled();
  });

  it('sin webhook_secret sigue consultando el pago', async () => {
    getActiveProvider.mockResolvedValue({
      id: 'prov-1',
      accessToken: 'APP_USR-test',
      webhookSecret: null,
      isSandbox: false,
    });

    await mercadoPagoWebhookHandler(paymentReq(), fakeRes());

    expect(verifyMpWebhookSignature).not.toHaveBeenCalled();
    expect(handleApprovedPayment).toHaveBeenCalled();
  });
});
