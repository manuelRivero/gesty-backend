/**
 * Tests de la exposición de los Goals de checkout (Fase 1 del roadmap de
 * migración). `resolveCheckoutPendingFromStep` reemplaza el flag persistido
 * `checkout_pending_action`/`checkout_pending_question` (V-06/V-08): dado el
 * mismo paso derivado por `nextCheckoutStep`, siempre debe devolver la misma
 * pregunta — no hay estado propio que pueda desincronizarse.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  resolveCheckoutPendingFromStep,
  checkoutGoalForStep,
  logCheckoutGoal,
} from '../checkoutGoal.service';
import {
  FULFILLMENT_TYPE_SHORT_QUESTION,
  PAYMENT_METHOD_SHORT_QUESTION,
  CONFIRM_ORDER_SHORT_QUESTION,
} from '../../productQuery/botMessages';

describe('resolveCheckoutPendingFromStep', () => {
  it('fulfillment → pending action estructurado con la pregunta corta', () => {
    expect(resolveCheckoutPendingFromStep('fulfillment')).toEqual({
      action: 'fulfillment_type',
      question: FULFILLMENT_TYPE_SHORT_QUESTION,
    });
  });

  it('payment → pending action estructurado con la pregunta corta', () => {
    expect(resolveCheckoutPendingFromStep('payment')).toEqual({
      action: 'payment_method',
      question: PAYMENT_METHOD_SHORT_QUESTION,
    });
  });

  it('confirm → pending action estructurado con la pregunta corta', () => {
    expect(resolveCheckoutPendingFromStep('confirm')).toEqual({
      action: 'confirm_order',
      question: CONFIRM_ORDER_SHORT_QUESTION,
    });
  });

  it('address → sin pending estructurado (se pide en lenguaje natural, sin botones)', () => {
    expect(resolveCheckoutPendingFromStep('address')).toEqual({ action: null, question: null });
  });

  it('name → sin pending estructurado', () => {
    expect(resolveCheckoutPendingFromStep('name')).toEqual({ action: null, question: null });
  });

  it('done → sin pending', () => {
    expect(resolveCheckoutPendingFromStep('done')).toEqual({ action: null, question: null });
  });
});

describe('checkoutGoalForStep — nombra el paso como uno de los Goals del catálogo', () => {
  it.each([
    ['fulfillment', 'DEFINIR_ENTREGA'],
    ['address', 'OBTENER_DIRECCION'],
    ['name', 'OBTENER_NOMBRE'],
    ['payment', 'DEFINIR_METODO_DE_PAGO'],
    ['confirm', 'CONFIRMAR_PEDIDO'],
    ['done', null],
  ] as const)('%s → %s', (step, expected) => {
    expect(checkoutGoalForStep(step)).toBe(expected);
  });
});

describe('logCheckoutGoal — traza obligatoria (ADR-0007)', () => {
  it('loguea el step y el Goal derivado', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logCheckoutGoal({ conversationId: 'conv-1', step: 'address' });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"goal":"OBTENER_DIRECCION"')
    );
    logSpy.mockRestore();
  });
});
