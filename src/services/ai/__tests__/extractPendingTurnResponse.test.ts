import { describe, expect, it } from 'vitest';
import {
  extractPendingTurnResponse,
  formatPendingExtractionBlock,
  isPaymentMethodValue,
} from '../extractPendingTurnResponse';
import {
  PaymentMethodPendingSchema,
  getCheckoutPendingActionConfig,
} from '../../checkout/pendingActionRegistry';

const paymentConfig = getCheckoutPendingActionConfig('payment_method')!;
const fulfillmentConfig = getCheckoutPendingActionConfig('fulfillment_type')!;

describe('extractPendingTurnResponse — deterministic', () => {
  it('efectivo → fulfilled + cash', async () => {
    const result = await extractPendingTurnResponse({
      userMessage: 'Efectivo',
      pendingAction: paymentConfig.pendingAction,
      botQuestion: paymentConfig.defaultQuestion,
      schema: paymentConfig.schema,
      valueHints: paymentConfig.valueHints,
      actionDescription: paymentConfig.actionDescription,
    });
    expect(result.status).toBe('fulfilled');
    expect(result.source).toBe('deterministic');
    expect(isPaymentMethodValue(result.value)).toBe(true);
    if (isPaymentMethodValue(result.value)) {
      expect(result.value.method).toBe('cash');
    }
  });

  it('tarjeta → fulfilled + online', async () => {
    const result = await extractPendingTurnResponse({
      userMessage: 'tarjeta',
      pendingAction: paymentConfig.pendingAction,
      botQuestion: paymentConfig.defaultQuestion,
      schema: paymentConfig.schema,
      valueHints: paymentConfig.valueHints,
      actionDescription: paymentConfig.actionDescription,
    });
    expect(result.status).toBe('fulfilled');
    if (isPaymentMethodValue(result.value)) {
      expect(result.value.method).toBe('online');
    }
  });

  it('mensaje vacío → reprompt', async () => {
    const result = await extractPendingTurnResponse({
      userMessage: '   ',
      pendingAction: paymentConfig.pendingAction,
      botQuestion: paymentConfig.defaultQuestion,
      schema: paymentConfig.schema,
      valueHints: paymentConfig.valueHints,
      actionDescription: paymentConfig.actionDescription,
    });
    expect(result.status).toBe('reprompt');
    expect(result.value).toBeNull();
  });

  it('quiero ver el menú → delegate', async () => {
    const result = await extractPendingTurnResponse({
      userMessage: 'quiero ver el menú',
      pendingAction: paymentConfig.pendingAction,
      botQuestion: paymentConfig.defaultQuestion,
      schema: paymentConfig.schema,
      valueHints: paymentConfig.valueHints,
      actionDescription: paymentConfig.actionDescription,
    });
    expect(result.status).toBe('delegate');
    expect(result.source).toBe('deterministic');
  });

  it('mejor retiro por el local con pending payment_method → off_pending + TAKE_AWAY', async () => {
    const result = await extractPendingTurnResponse({
      userMessage: 'mejor retiro por el local',
      pendingAction: paymentConfig.pendingAction,
      botQuestion: paymentConfig.defaultQuestion,
      schema: paymentConfig.schema,
      valueHints: paymentConfig.valueHints,
      actionDescription: paymentConfig.actionDescription,
    });
    expect(result.status).toBe('off_pending');
    expect(result.resolvedAction).toBe('fulfillment_type');
    expect(result.value).toEqual({ type: 'TAKE_AWAY' });
    expect(result.source).toBe('deterministic');
  });
});

describe('extractPendingTurnResponse — fulfillment_type', () => {
  it('en casa → fulfilled + DELIVERY', async () => {
    const result = await extractPendingTurnResponse({
      userMessage: 'en casa',
      pendingAction: fulfillmentConfig.pendingAction,
      botQuestion: fulfillmentConfig.defaultQuestion,
      schema: fulfillmentConfig.schema,
      valueHints: fulfillmentConfig.valueHints,
      actionDescription: fulfillmentConfig.actionDescription,
    });
    expect(result.status).toBe('fulfilled');
    expect(result.source).toBe('deterministic');
    expect(result.value).toEqual({ type: 'DELIVERY' });
  });

  it('retiro → fulfilled + TAKE_AWAY', async () => {
    const result = await extractPendingTurnResponse({
      userMessage: 'retiro',
      pendingAction: fulfillmentConfig.pendingAction,
      botQuestion: fulfillmentConfig.defaultQuestion,
      schema: fulfillmentConfig.schema,
      valueHints: fulfillmentConfig.valueHints,
      actionDescription: fulfillmentConfig.actionDescription,
    });
    expect(result.status).toBe('fulfilled');
    expect(result.value).toEqual({ type: 'TAKE_AWAY' });
  });

  it('quiero pagar → delegate', async () => {
    const result = await extractPendingTurnResponse({
      userMessage: 'quiero pagar',
      pendingAction: fulfillmentConfig.pendingAction,
      botQuestion: fulfillmentConfig.defaultQuestion,
      schema: fulfillmentConfig.schema,
      valueHints: fulfillmentConfig.valueHints,
      actionDescription: fulfillmentConfig.actionDescription,
    });
    expect(result.status).toBe('delegate');
  });

  it('efectivo con pending fulfillment_type → off_pending + cash', async () => {
    const result = await extractPendingTurnResponse({
      userMessage: 'efectivo',
      pendingAction: fulfillmentConfig.pendingAction,
      botQuestion: fulfillmentConfig.defaultQuestion,
      schema: fulfillmentConfig.schema,
      valueHints: fulfillmentConfig.valueHints,
      actionDescription: fulfillmentConfig.actionDescription,
    });
    expect(result.status).toBe('off_pending');
    expect(result.resolvedAction).toBe('payment_method');
    expect(result.value).toEqual({ method: 'cash' });
  });
});

describe('formatPendingExtractionBlock', () => {
  it('incluye valor extraído cuando fulfilled', () => {
    const block = formatPendingExtractionBlock({
      pendingAction: 'payment_method',
      botQuestion: '¿Cómo querés pagar?',
      status: 'fulfilled',
      confidence: 0.95,
      value: { method: 'cash' },
      reason: 'efectivo_explicito',
    });
    expect(block).toContain('[EXTRACCIÓN PASO PENDIENTE]');
    expect(block).toContain('Estado: fulfilled');
    expect(block).toContain('{"method":"cash"}');
  });

  it('incluye campo respondido cuando off_pending', () => {
    const block = formatPendingExtractionBlock({
      pendingAction: 'payment_method',
      botQuestion: '¿Cómo querés pagar?',
      status: 'off_pending',
      confidence: 0.95,
      value: { type: 'TAKE_AWAY' },
      reason: 'takeaway_explicito',
      resolvedAction: 'fulfillment_type',
    });
    expect(block).toContain('Estado: off_pending');
    expect(block).toContain('Campo respondido: fulfillment_type');
    expect(block).toContain('{"type":"TAKE_AWAY"}');
  });
});

describe('PaymentMethodPendingSchema', () => {
  it('acepta cash y online', () => {
    expect(PaymentMethodPendingSchema.safeParse({ method: 'cash' }).success).toBe(true);
    expect(PaymentMethodPendingSchema.safeParse({ method: 'online' }).success).toBe(true);
    expect(PaymentMethodPendingSchema.safeParse({ method: 'bitcoin' }).success).toBe(false);
  });
});
