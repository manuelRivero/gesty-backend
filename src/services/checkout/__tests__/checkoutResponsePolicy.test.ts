import { describe, expect, it } from 'vitest';
import { applyCheckoutResponsePolicy } from '../checkoutResponsePolicy';
import type { CheckoutAgentSignals } from '../../../agents/checkoutAgent';

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

describe('applyCheckoutResponsePolicy', () => {
  it('Caso 1: orden creada (orderId presente) + texto de confirmación → deja pasar y habilita las tres afirmaciones', () => {
    const result = applyCheckoutResponsePolicy(
      { text: '¡Pedido confirmado!', signals: baseSignals() },
      { fulfillmentType: 'DELIVERY', paymentMethod: 'cash', orderId: '12345' }
    );

    expect(result.responseAllowed).toBe(true);
    expect(result.completionClaimAllowed).toBe(true);
    expect(result.orderConfirmationAllowed).toBe(true);
    expect(result.corrections).toEqual([]);
    expect(result.text).toBe('¡Pedido confirmado!');
  });

  it('Caso 2: no existe pedido (orderId null) y no hay señal reconocida → bloquea la respuesta y las afirmaciones de negocio', () => {
    const result = applyCheckoutResponsePolicy(
      { text: '¡Ya está todo listo!', signals: baseSignals() },
      { fulfillmentType: 'DELIVERY', paymentMethod: 'cash', orderId: null }
    );

    expect(result.responseAllowed).toBe(false);
    expect(result.completionClaimAllowed).toBe(false);
    expect(result.orderConfirmationAllowed).toBe(false);
    expect(result.corrections).toContain('closure_claim_without_evidence');
    expect(result.text).not.toBe('¡Ya está todo listo!');
  });

  it('Caso 3: fulfillment seleccionado pero sin orderId ni señal → no confirma, pide el siguiente dato faltante', () => {
    const result = applyCheckoutResponsePolicy(
      { text: 'Perfecto, delivery entonces. ¡Todo listo!', signals: baseSignals() },
      { fulfillmentType: 'DELIVERY', paymentMethod: null, orderId: null }
    );

    expect(result.responseAllowed).toBe(false);
    expect(result.corrections).toContain('closure_claim_without_evidence');
  });

  it('Caso 4: presentPaymentOptions habilita enviar el texto, pero NO habilita afirmar datos completos ni orden confirmada', () => {
    const result = applyCheckoutResponsePolicy(
      { text: 'Perfecto, elegí cómo pagar.', signals: { ...baseSignals(), presentPaymentOptions: true } },
      { fulfillmentType: 'DELIVERY', paymentMethod: null, orderId: null }
    );

    expect(result.responseAllowed).toBe(true);
    expect(result.completionClaimAllowed).toBe(false);
    expect(result.orderConfirmationAllowed).toBe(false);
    expect(result.text).toBe('Perfecto, elegí cómo pagar.');
  });

  it('Caso 5: delegate_to_main habilita enviar el texto, pero NO habilita afirmar orden confirmada', () => {
    const result = applyCheckoutResponsePolicy(
      {
        text: 'Los horarios son de 12 a 23hs.',
        signals: { ...baseSignals(), delegateToMain: true, delegateToMainReason: 'pregunta por horarios' },
      },
      { fulfillmentType: null, paymentMethod: null, orderId: null }
    );

    expect(result.responseAllowed).toBe(true);
    expect(result.completionClaimAllowed).toBe(false);
    expect(result.orderConfirmationAllowed).toBe(false);
    expect(result.text).toBe('Los horarios son de 12 a 23hs.');
  });

  it('Caso 6: señal paymentMethod (guardado, sin orderId todavía) habilita enviar el texto, pero no confirma la orden', () => {
    const result = applyCheckoutResponsePolicy(
      { text: 'Genial, pagás en efectivo.', signals: { ...baseSignals(), paymentMethod: 'cash' } },
      { fulfillmentType: 'DELIVERY', paymentMethod: 'cash', orderId: null }
    );

    expect(result.responseAllowed).toBe(true);
    expect(result.orderConfirmationAllowed).toBe(false);
    expect(result.text).toBe('Genial, pagás en efectivo.');
  });
});
