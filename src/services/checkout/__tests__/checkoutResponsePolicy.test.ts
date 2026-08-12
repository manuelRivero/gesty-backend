import { describe, expect, it } from 'vitest';
import {
  applyCheckoutResponsePolicy,
  buildContinuationMessage,
} from '../checkoutResponsePolicy';
import type { CheckoutResponsePolicyState } from '../checkoutResponsePolicy';
import type { CheckoutAgentSignals } from '../../../agents/checkoutAgent';
import {
  CUSTOMER_NAME_PROMPT_BOT_MESSAGE,
  PAYMENT_METHOD_PROMPT_BOT_MESSAGE,
} from '../../productQuery/botMessages';

const baseSignals = (): CheckoutAgentSignals => ({
  presentFulfillmentOptions: false,
  presentPaymentOptions: false,
  delegateToMain: false,
  delegateToMainReason: null,
  handback: false,
  handbackReason: null,
  paymentMethod: null,
  orderConfirmationResolved: null,
});

const baseState = (
  overrides: Partial<CheckoutResponsePolicyState> = {}
): CheckoutResponsePolicyState => ({
  fulfillmentType: 'TAKE_AWAY',
  paymentMethod: null,
  orderId: null,
  hasAddress: true,
  isInCoverage: true,
  customerName: null,
  deliveryEnabled: true,
  takeawayEnabled: true,
  ...overrides,
});

describe('applyCheckoutResponsePolicy (D5-A)', () => {
  it('tipable: save_fulfillment implícito + texto pidiendo nombre → texto del agente intacto', () => {
    const agentText =
      '🤖\n\n*Retiro* 🛍️\n\nPerfecto, lo preparo para retirar. ¿Con qué nombre anotamos el pedido?';
    const result = applyCheckoutResponsePolicy(
      { text: agentText, signals: baseSignals() },
      baseState({ fulfillmentType: 'TAKE_AWAY', customerName: null })
    );

    expect(result.responseAllowed).toBe(true);
    expect(result.corrections).toEqual([]);
    expect(result.text).toBe(agentText);
    expect(result.orderConfirmationAllowed).toBe(false);
    expect(result.completionClaimAllowed).toBe(false);
  });

  it('sin tools + step name + texto vacío → fallback de nombre, nunca de pago', () => {
    const result = applyCheckoutResponsePolicy(
      { text: '   ', signals: baseSignals() },
      baseState({ fulfillmentType: 'TAKE_AWAY', customerName: null })
    );

    expect(result.responseAllowed).toBe(false);
    expect(result.corrections).toContain('empty_agent_response');
    expect(result.text).toBe(CUSTOMER_NAME_PROMPT_BOT_MESSAGE);
    expect(result.text).not.toBe(PAYMENT_METHOD_PROMPT_BOT_MESSAGE);
  });

  it('step payment + texto vacío → prompt de pago (regresión V-25 / UI adjunta botones en el nodo)', () => {
    const result = applyCheckoutResponsePolicy(
      { text: '', signals: baseSignals() },
      baseState({ fulfillmentType: 'TAKE_AWAY', customerName: 'Ana', paymentMethod: null })
    );

    expect(result.responseAllowed).toBe(false);
    expect(result.text).toBe(PAYMENT_METHOD_PROMPT_BOT_MESSAGE);
  });

  it('orderId presente → deja pasar y habilita afirmaciones de orden', () => {
    const result = applyCheckoutResponsePolicy(
      { text: '¡Pedido confirmado!', signals: baseSignals() },
      baseState({
        fulfillmentType: 'DELIVERY',
        paymentMethod: 'cash',
        customerName: 'Ana',
        orderId: '12345',
      })
    );

    expect(result.responseAllowed).toBe(true);
    expect(result.completionClaimAllowed).toBe(true);
    expect(result.orderConfirmationAllowed).toBe(true);
    expect(result.corrections).toEqual([]);
    expect(result.text).toBe('¡Pedido confirmado!');
  });

  it('presentPaymentOptions no es requisito para enviar prosa tipable', () => {
    const result = applyCheckoutResponsePolicy(
      { text: '¿Me decís tu nombre?', signals: baseSignals() },
      baseState({ customerName: null })
    );

    expect(result.responseAllowed).toBe(true);
    expect(result.text).toBe('¿Me decís tu nombre?');
  });

  it('delegate_to_main + texto → se envía; no habilita orden confirmada', () => {
    const result = applyCheckoutResponsePolicy(
      {
        text: 'Los horarios son de 12 a 23hs.',
        signals: {
          ...baseSignals(),
          delegateToMain: true,
          delegateToMainReason: 'pregunta por horarios',
        },
      },
      baseState({ fulfillmentType: null })
    );

    expect(result.responseAllowed).toBe(true);
    expect(result.orderConfirmationAllowed).toBe(false);
    expect(result.text).toBe('Los horarios son de 12 a 23hs.');
  });
});

describe('buildContinuationMessage', () => {
  it('deriva del paso name, no salta a payment', () => {
    expect(
      buildContinuationMessage(
        baseState({ fulfillmentType: 'TAKE_AWAY', customerName: null, paymentMethod: null })
      )
    ).toBe(CUSTOMER_NAME_PROMPT_BOT_MESSAGE);
  });

  it('step payment → mensaje de pago', () => {
    expect(
      buildContinuationMessage(
        baseState({ fulfillmentType: 'TAKE_AWAY', customerName: 'Ana', paymentMethod: null })
      )
    ).toBe(PAYMENT_METHOD_PROMPT_BOT_MESSAGE);
  });
});
