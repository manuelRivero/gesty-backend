import { describe, it, expect } from 'vitest';
import { isCancelOrderHandback } from '../cancelOrderHandback';

describe('isCancelOrderHandback', () => {
  it('detecta reason tipico del prompt de checkout', () => {
    expect(
      isCancelOrderHandback({
        reason: 'el cliente quiere cancelar el pedido',
      })
    ).toBe(true);
  });

  it('detecta tipable del usuario', () => {
    expect(isCancelOrderHandback({ userMessage: 'Cancelar pedido' })).toBe(true);
    expect(isCancelOrderHandback({ userMessage: 'cancelá todo' })).toBe(true);
    expect(isCancelOrderHandback({ userMessage: 'borrá el carrito' })).toBe(true);
  });

  it('no confunde handback de editar / menú', () => {
    expect(
      isCancelOrderHandback({
        reason: 'el cliente quiere agregar ítems',
        userMessage: 'quiero sumar una bebida',
      })
    ).toBe(false);
    expect(
      isCancelOrderHandback({
        reason: 'el cliente quiere ver el menú',
      })
    ).toBe(false);
  });
});
