import { describe, expect, it } from 'vitest';
import {
  PaymentMethodCombinationError,
  assertValidPaymentMethodCombination,
  filterMethodsForFulfillmentContext,
  projectActiveMethodsAfterChange,
} from '../paymentMethodRules';
import { parsePayButtonId } from '../paymentMethods';

describe('filterMethodsForFulfillmentContext', () => {
  it('con delivery externo excluye cash', () => {
    expect(
      filterMethodsForFulfillmentContext(['cash', 'online', 'transfer'], {
        externalDeliveryEnabled: true,
      })
    ).toEqual(['online', 'transfer']);
  });

  it('sin delivery externo deja todos', () => {
    expect(
      filterMethodsForFulfillmentContext(['cash', 'online'], {
        externalDeliveryEnabled: false,
      })
    ).toEqual(['cash', 'online']);
  });
});

describe('assertValidPaymentMethodCombination', () => {
  it('permite 0 métodos activos (D3)', () => {
    expect(() =>
      assertValidPaymentMethodCombination({
        activeMethods: [
          { paymentMethod: 'cash', isActive: false },
          { paymentMethod: 'online', isActive: false },
        ],
        externalDeliveryEnabled: false,
      })
    ).not.toThrow();
  });

  it('con external y 0 activos permite (cobro se exige al enable orders)', () => {
    expect(() =>
      assertValidPaymentMethodCombination({
        activeMethods: [{ paymentMethod: 'cash', isActive: false }],
        externalDeliveryEnabled: true,
      })
    ).not.toThrow();
  });

  it('con external exige método no-cash y rechaza cash activo', () => {
    expect(() =>
      assertValidPaymentMethodCombination({
        activeMethods: [{ paymentMethod: 'cash', isActive: true }],
        externalDeliveryEnabled: true,
      })
    ).toThrow(/delivery externo/);

    expect(() =>
      assertValidPaymentMethodCombination({
        activeMethods: [
          { paymentMethod: 'cash', isActive: false },
          { paymentMethod: 'online', isActive: true },
        ],
        externalDeliveryEnabled: true,
      })
    ).not.toThrow();
  });
});

describe('projectActiveMethodsAfterChange', () => {
  it('proyecta desactivar cash', () => {
    const projected = projectActiveMethodsAfterChange({
      current: [
        { paymentMethod: 'cash', isActive: true },
        { paymentMethod: 'online', isActive: true },
      ],
      change: { type: 'upsert', paymentMethod: 'cash', isActive: false },
    });
    expect(projected.find((m) => m.paymentMethod === 'cash')?.isActive).toBe(false);
  });
});

describe('parsePayButtonId', () => {
  it('parsea PAY_* al id de catálogo', () => {
    expect(parsePayButtonId('PAY_CASH')).toBe('cash');
    expect(parsePayButtonId('PAY_ONLINE')).toBe('online');
    expect(parsePayButtonId('PAY_TRANSFER')).toBe('transfer');
    expect(parsePayButtonId('CONFIRM_ORDER')).toBeNull();
  });
});
