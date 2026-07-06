import { describe, expect, it } from 'vitest';
import { wantsCheckout } from '../checkoutIntentText';

describe('wantsCheckout', () => {
  it('detecta pagar y variantes de cierre', () => {
    expect(wantsCheckout('Pagar')).toBe(true);
    expect(wantsCheckout('quiero pagar')).toBe(true);
    expect(wantsCheckout('finalizar pedido')).toBe(true);
    expect(wantsCheckout('quiero finalizar el pedido')).toBe(true);
    expect(wantsCheckout('cerrar compra')).toBe(true);
    expect(wantsCheckout('listo para pagar')).toBe(true);
  });

  it('no confunde con ver o modificar el carrito', () => {
    expect(wantsCheckout('modificar pedido')).toBe(false);
    expect(wantsCheckout('ver mi pedido')).toBe(false);
    expect(wantsCheckout('quiero editar el carrito')).toBe(false);
  });

  it('no confunde con consultas de monto o método', () => {
    expect(wantsCheckout('cuánto tengo que pagar')).toBe(false);
    expect(wantsCheckout('cómo puedo pagar')).toBe(false);
  });
});
