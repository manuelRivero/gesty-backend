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
});
