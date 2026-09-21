import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    payment_intent: { findFirst: vi.fn() },
    business: { findUnique: vi.fn() },
  },
}));

import { prisma } from '../../../lib/prisma';
import { renderPaymentReturnHtml } from '../../../controllers/payments/paymentReturn.controller';
import {
  buildWhatsAppChatUrl,
  paymentReturnCopy,
  resolvePaymentReturnPage,
} from '../paymentReturnPage.service';

const mockedFindFirst = prisma.payment_intent.findFirst as unknown as ReturnType<
  typeof vi.fn
>;
const mockedBusinessFind = prisma.business.findUnique as unknown as ReturnType<
  typeof vi.fn
>;

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
const DRAFT_ID = '22222222-2222-2222-2222-222222222222';
const ORDER_ID = '33333333-3333-3333-3333-333333333333';

describe('buildWhatsAppChatUrl', () => {
  it('arma wa.me con dígitos', () => {
    expect(buildWhatsAppChatUrl('+54 9 11 1234-5678')).toBe(
      'https://wa.me/5491112345678'
    );
  });

  it('null si teléfono inválido', () => {
    expect(buildWhatsAppChatUrl('123')).toBeNull();
    expect(buildWhatsAppChatUrl(null)).toBeNull();
  });
});

describe('resolvePaymentReturnPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('success approved: nombre, monto, orderRef, chatUrl, no confirming', async () => {
    mockedFindFirst.mockResolvedValue({
      status: 'approved',
      amount: new Prisma.Decimal('1500.50'),
      currency: 'ARS',
      order_id: ORDER_ID,
      business: {
        name: 'Pizzería Demo',
        whatsapp_phone_number: '5491112345678',
      },
    });

    const model = await resolvePaymentReturnPage({
      kind: 'success',
      businessId: BUSINESS_ID,
      externalReference: DRAFT_ID,
    });

    expect(model.businessName).toBe('Pizzería Demo');
    expect(model.orderRef).toBe('33333333');
    expect(model.confirming).toBe(false);
    expect(model.chatUrl).toBe('https://wa.me/5491112345678');
    expect(model.amountLabel).toContain('1');
    expect(paymentReturnCopy(model).title).toBe('Pago recibido');
  });

  it('success pending intent: confirming', async () => {
    mockedFindFirst.mockResolvedValue({
      status: 'pending',
      amount: new Prisma.Decimal('100'),
      currency: 'ARS',
      order_id: null,
      business: {
        name: 'Local X',
        whatsapp_phone_number: '5491199999999',
      },
    });

    const model = await resolvePaymentReturnPage({
      kind: 'success',
      businessId: BUSINESS_ID,
      externalReference: DRAFT_ID,
    });

    expect(model.confirming).toBe(true);
    expect(model.orderRef).toBeNull();
    expect(paymentReturnCopy(model).title).toBe('Confirmando tu pago…');
  });

  it('sin intent: fallback business por id', async () => {
    mockedFindFirst.mockResolvedValue(null);
    mockedBusinessFind.mockResolvedValue({
      name: 'Solo Nombre',
      whatsapp_phone_number: null,
    });

    const model = await resolvePaymentReturnPage({
      kind: 'failure',
      businessId: BUSINESS_ID,
    });

    expect(model.businessName).toBe('Solo Nombre');
    expect(model.chatUrl).toBeNull();
    expect(paymentReturnCopy(model).title).toBe('Pago no completado');
  });

  it('sin query: modelo vacío genérico', async () => {
    const model = await resolvePaymentReturnPage({ kind: 'pending' });
    expect(mockedFindFirst).not.toHaveBeenCalled();
    expect(model.businessName).toBeNull();
    expect(paymentReturnCopy(model).title).toBe('Pago en proceso');
  });
});

describe('renderPaymentReturnHtml', () => {
  it('incluye negocio, estado, CTA wa.me', () => {
    const html = renderPaymentReturnHtml({
      kind: 'success',
      businessName: 'Pizzería Demo',
      amountLabel: '$1.500,50',
      orderRef: 'ABCDEF12',
      confirming: false,
      chatUrl: 'https://wa.me/5491112345678',
    });

    expect(html).toContain('Pizzería Demo');
    expect(html).toContain('Pago recibido');
    expect(html).toContain('Pedido #ABCDEF12');
    expect(html).toContain('$1.500,50');
    expect(html).toContain('href="https://wa.me/5491112345678"');
    expect(html).toContain('Volver al chat');
    expect(html).toContain('Podés cerrar esta página tranquilo');
  });

  it('sin chatUrl muestra hint; escapa HTML', () => {
    const html = renderPaymentReturnHtml({
      kind: 'failure',
      businessName: '<script>x</script>',
      amountLabel: null,
      orderRef: null,
      confirming: false,
      chatUrl: null,
    });

    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('Volvé al chat de WhatsApp');
    expect(html).toContain('Pago no completado');
  });

  it('success confirming incluye meta refresh', () => {
    const html = renderPaymentReturnHtml({
      kind: 'success',
      businessName: 'Local',
      amountLabel: null,
      orderRef: null,
      confirming: true,
      chatUrl: null,
    });

    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain('Confirmando tu pago…');
  });
});
