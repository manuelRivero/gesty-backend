/**
 * Fase 7, Tarea 7.2 (PLAN-ACCION-COMPROBANTES-CIERRE.md): checks
 * determinísticos sobre un comprobante de transferencia.
 */

import { describe, expect, it } from 'vitest';
import { computePaymentProofChecks } from '../paymentProofChecks';
import type { PaymentProofVisionResult } from '../../ai/paymentProofVision.service';

const now = new Date('2026-08-07T15:00:00.000Z');
const orderCreatedAt = new Date('2026-08-07T14:00:00.000Z');

function buildExtracted(overrides: Partial<PaymentProofVisionResult> = {}): PaymentProofVisionResult {
  return {
    kind: 'transfer_voucher',
    legibility: 'clear',
    amount: 1500,
    currency: 'ARS',
    operation_number: 'OP-123',
    transferred_at: '2026-08-07T14:30:00.000Z',
    sender_name: 'Juan Pérez',
    bank: 'Mercado Pago',
    destination_alias: 'mi.alias.mp',
    destination_cbu: '0000003100010000000001',
    destination_holder: 'Local SRL',
    ...overrides,
  };
}

const bankConfig = { bank_alias: 'mi.alias.mp', bank_cbu: '0000003100010000000001' };
const order = { total_amount: 1500, created_at: orderCreatedAt };

describe('computePaymentProofChecks', () => {
  describe('amount_matches', () => {
    it('pass cuando el monto extraído coincide exacto con el total de la orden', () => {
      const checks = computePaymentProofChecks({
        extracted: buildExtracted({ amount: 1500 }),
        order,
        bankConfig,
        operationNumberAlreadyUsed: false,
        imageReusedInOrderId: null,
        now,
      });
      expect(checks.amount_matches).toBe('pass');
    });

    it('fail cuando el monto no coincide', () => {
      const checks = computePaymentProofChecks({
        extracted: buildExtracted({ amount: 999 }),
        order,
        bankConfig,
        operationNumberAlreadyUsed: false,
        imageReusedInOrderId: null,
        now,
      });
      expect(checks.amount_matches).toBe('fail');
    });

    it('unknown cuando no se pudo extraer el monto', () => {
      const checks = computePaymentProofChecks({
        extracted: buildExtracted({ amount: null }),
        order,
        bankConfig,
        operationNumberAlreadyUsed: false,
        imageReusedInOrderId: null,
        now,
      });
      expect(checks.amount_matches).toBe('unknown');
    });
  });

  describe('destination_matches', () => {
    it('pass cuando el alias coincide (normalizado)', () => {
      const checks = computePaymentProofChecks({
        extracted: buildExtracted({ destination_alias: 'MI.ALIAS.MP', destination_cbu: null }),
        order,
        bankConfig,
        operationNumberAlreadyUsed: false,
        imageReusedInOrderId: null,
        now,
      });
      expect(checks.destination_matches).toBe('pass');
    });

    it('pass cuando el CBU coincide (normalizado, con espacios/guiones)', () => {
      const checks = computePaymentProofChecks({
        extracted: buildExtracted({ destination_alias: null, destination_cbu: '0000-0031-0001-0000000001' }),
        order,
        bankConfig,
        operationNumberAlreadyUsed: false,
        imageReusedInOrderId: null,
        now,
      });
      expect(checks.destination_matches).toBe('pass');
    });

    it('fail cuando ni el alias ni el CBU coinciden', () => {
      const checks = computePaymentProofChecks({
        extracted: buildExtracted({ destination_alias: 'otro.alias', destination_cbu: '9999999999999999999999' }),
        order,
        bankConfig,
        operationNumberAlreadyUsed: false,
        imageReusedInOrderId: null,
        now,
      });
      expect(checks.destination_matches).toBe('fail');
    });

    it('unknown cuando el local no configuró datos bancarios', () => {
      const checks = computePaymentProofChecks({
        extracted: buildExtracted(),
        order,
        bankConfig: { bank_alias: null, bank_cbu: null },
        operationNumberAlreadyUsed: false,
        imageReusedInOrderId: null,
        now,
      });
      expect(checks.destination_matches).toBe('unknown');
    });

    it('unknown cuando no se pudo extraer ni alias ni CBU del comprobante', () => {
      const checks = computePaymentProofChecks({
        extracted: buildExtracted({ destination_alias: null, destination_cbu: null }),
        order,
        bankConfig,
        operationNumberAlreadyUsed: false,
        imageReusedInOrderId: null,
        now,
      });
      expect(checks.destination_matches).toBe('unknown');
    });
  });

  describe('date_within_window', () => {
    it('pass cuando la fecha está entre la creación de la orden y ahora', () => {
      const checks = computePaymentProofChecks({
        extracted: buildExtracted({ transferred_at: '2026-08-07T14:30:00.000Z' }),
        order,
        bankConfig,
        operationNumberAlreadyUsed: false,
        imageReusedInOrderId: null,
        now,
      });
      expect(checks.date_within_window).toBe('pass');
    });

    it('fail cuando la fecha es muy anterior a la creación de la orden', () => {
      const checks = computePaymentProofChecks({
        extracted: buildExtracted({ transferred_at: '2026-08-01T00:00:00.000Z' }),
        order,
        bankConfig,
        operationNumberAlreadyUsed: false,
        imageReusedInOrderId: null,
        now,
      });
      expect(checks.date_within_window).toBe('fail');
    });

    it('fail cuando la fecha es posterior a ahora', () => {
      const checks = computePaymentProofChecks({
        extracted: buildExtracted({ transferred_at: '2026-08-08T00:00:00.000Z' }),
        order,
        bankConfig,
        operationNumberAlreadyUsed: false,
        imageReusedInOrderId: null,
        now,
      });
      expect(checks.date_within_window).toBe('fail');
    });

    it('unknown cuando no se pudo extraer la fecha', () => {
      const checks = computePaymentProofChecks({
        extracted: buildExtracted({ transferred_at: null }),
        order,
        bankConfig,
        operationNumberAlreadyUsed: false,
        imageReusedInOrderId: null,
        now,
      });
      expect(checks.date_within_window).toBe('unknown');
    });
  });

  describe('operation_number_unique', () => {
    it('pass cuando el número de operación no se repite', () => {
      const checks = computePaymentProofChecks({
        extracted: buildExtracted(),
        order,
        bankConfig,
        operationNumberAlreadyUsed: false,
        imageReusedInOrderId: null,
        now,
      });
      expect(checks.operation_number_unique).toBe('pass');
    });

    it('fail cuando el número de operación ya existe en otro proof del negocio', () => {
      const checks = computePaymentProofChecks({
        extracted: buildExtracted(),
        order,
        bankConfig,
        operationNumberAlreadyUsed: true,
        imageReusedInOrderId: null,
        now,
      });
      expect(checks.operation_number_unique).toBe('fail');
    });

    it('unknown cuando no se pudo extraer el número de operación', () => {
      const checks = computePaymentProofChecks({
        extracted: buildExtracted({ operation_number: null }),
        order,
        bankConfig,
        operationNumberAlreadyUsed: false,
        imageReusedInOrderId: null,
        now,
      });
      expect(checks.operation_number_unique).toBe('unknown');
    });
  });

  describe('image_not_reused', () => {
    it('pass cuando el hash no aparece en otra orden', () => {
      const checks = computePaymentProofChecks({
        extracted: buildExtracted(),
        order,
        bankConfig,
        operationNumberAlreadyUsed: false,
        imageReusedInOrderId: null,
        now,
      });
      expect(checks.image_not_reused).toBe('pass');
      expect(checks.image_reused_in_order_id).toBeUndefined();
    });

    it('fail cuando el hash ya aparece en otra orden, e incluye el id de esa orden', () => {
      const checks = computePaymentProofChecks({
        extracted: buildExtracted(),
        order,
        bankConfig,
        operationNumberAlreadyUsed: false,
        imageReusedInOrderId: 'order-viejo',
        now,
      });
      expect(checks.image_not_reused).toBe('fail');
      expect(checks.image_reused_in_order_id).toBe('order-viejo');
    });
  });

  it('un comprobante ilegible (sin extracción) produce todos unknown y ningún fail', () => {
    const checks = computePaymentProofChecks({
      extracted: null,
      order,
      bankConfig,
      operationNumberAlreadyUsed: false,
      imageReusedInOrderId: null,
      now,
    });

    expect(checks.amount_matches).toBe('unknown');
    expect(checks.destination_matches).toBe('unknown');
    expect(checks.date_within_window).toBe('unknown');
    expect(checks.operation_number_unique).toBe('unknown');
    // image_not_reused es independiente de la extracción: sigue siendo pass.
    expect(checks.image_not_reused).toBe('pass');

    expect(Object.values(checks)).not.toContain('fail');
  });
});
