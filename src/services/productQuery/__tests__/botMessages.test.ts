import { describe, expect, it } from 'vitest';
import { parseBotUserMessage } from '../utils';
import {
  ADDRESS_REQUIRED_BOT_MESSAGE,
  CLOSED_ORDER_CANCELLED_BOT_MESSAGE,
  EMPTY_CART_BOT_MESSAGE,
  buildOrderConfirmedCashMessage,
  buildProvideNameThanksMessage,
} from '../botMessages';

describe('botMessages', () => {
  it('exporta mensajes compartidos con formato parseable', () => {
    for (const message of [
      EMPTY_CART_BOT_MESSAGE,
      CLOSED_ORDER_CANCELLED_BOT_MESSAGE,
      ADDRESS_REQUIRED_BOT_MESSAGE,
      buildProvideNameThanksMessage('Ana'),
      buildOrderConfirmedCashMessage({ orderId: 'abc-123', total: 1500 }),
    ]) {
      expect(parseBotUserMessage(message)).not.toBeNull();
    }
  });

  describe('buildOrderConfirmedCashMessage — variante transferencia (Tarea 4.2)', () => {
    it('incluye la invitación a mandar el comprobante cuando isBankTransfer es true', () => {
      const message = buildOrderConfirmedCashMessage({
        orderId: 'abc-123',
        total: 1500,
        paymentLabel: 'Transferencia',
        isBankTransfer: true,
      });

      expect(parseBotUserMessage(message)).not.toBeNull();
      expect(message).toContain('mandame la foto o captura del comprobante');
    });

    it('no incluye la invitación para efectivo (isBankTransfer ausente/false)', () => {
      const cash = buildOrderConfirmedCashMessage({ orderId: 'abc-123', total: 1500 });
      expect(cash).not.toContain('mandame la foto o captura del comprobante');

      const online = buildOrderConfirmedCashMessage({
        orderId: 'abc-123',
        total: 1500,
        paymentLabel: 'Pago online',
        isBankTransfer: false,
      });
      expect(online).not.toContain('mandame la foto o captura del comprobante');
    });
  });
});
