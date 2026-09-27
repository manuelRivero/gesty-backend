import { describe, it, expect } from 'vitest';
import {
  isCancelOrderHandback,
  isStructuredOrderCancel,
} from '../cancelOrderHandback';

describe('isCancelOrderHandback', () => {
  it('un reason que habla de cancelar no es wipe', () => {
    expect(
      isCancelOrderHandback({
        reason: 'el cliente quiere cancelar el pedido',
      })
    ).toBe(false);
  });

  it('el texto del usuario no es wipe', () => {
    expect(isCancelOrderHandback({ userMessage: 'Cancelar pedido' })).toBe(false);
    expect(isCancelOrderHandback({ userMessage: 'cancelá todo' })).toBe(false);
    expect(isCancelOrderHandback({ userMessage: 'borrá el carrito' })).toBe(false);
    expect(isCancelOrderHandback({ userMessage: 'sacá la provoleta' })).toBe(false);
  });

  it('handback de editar / menú tampoco borra', () => {
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

describe('isStructuredOrderCancel', () => {
  it('solo la señal cancel_order autoriza el wipe', () => {
    expect(isStructuredOrderCancel('cancel_order')).toBe(true);
    expect(isStructuredOrderCancel('handback_to_main')).toBe(false);
    expect(isStructuredOrderCancel(undefined)).toBe(false);
  });
});
