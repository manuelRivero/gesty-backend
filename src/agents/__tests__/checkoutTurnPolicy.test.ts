import { describe, expect, it, vi } from 'vitest';
import {
  applyCheckoutTurnGate,
  CHECKOUT_EMPTY_CART_MESSAGE,
  resolveCheckoutTurn,
  toolMessageMutatedCart,
} from '../checkoutTurnPolicy';

describe('start_checkout_session después del invoke', () => {
  it('A1: la carrera add+checkout ya no es empty_cart; la lectura ve el ítem', async () => {
    const readDraftHasItems = vi.fn().mockResolvedValue(true);
    const decision = await applyCheckoutTurnGate({
      startCheckoutSession: true,
      startCheckoutReason: 'cerrar',
      cartMutatedThisTurn: toolMessageMutatedCart('add_cart_item', true),
      readDraftHasItems,
    });
    expect(readDraftHasItems).toHaveBeenCalledOnce();
    expect(decision).toEqual({ type: 'defer_present_cart', draftHasItems: true });
    expect(decision.type).not.toBe('empty_cart');
  });

  it('A2: solo checkout y draft vacío no delega', async () => {
    const readDraftHasItems = vi.fn().mockResolvedValue(false);
    const decision = await applyCheckoutTurnGate({
      startCheckoutSession: true,
      startCheckoutReason: 'cerrar',
      cartMutatedThisTurn: false,
      readDraftHasItems,
    });
    expect(decision).toEqual({ type: 'empty_cart' });
    expect(CHECKOUT_EMPTY_CART_MESSAGE).toMatch(/carrito está vacío/);
    expect(readDraftHasItems).toHaveBeenCalledOnce();
  });

  it('sin mutación y con ítems delega', async () => {
    const decision = resolveCheckoutTurn({
      startCheckoutSession: true,
      startCheckoutReason: 'quiere pagar',
      cartMutatedThisTurn: false,
      draftHasItems: true,
    });
    expect(decision).toEqual({ type: 'delegate', reason: 'quiere pagar' });
  });

  it('sin señal de checkout no lee el draft', async () => {
    const readDraftHasItems = vi.fn();
    const decision = await applyCheckoutTurnGate({
      startCheckoutSession: false,
      startCheckoutReason: null,
      cartMutatedThisTurn: false,
      readDraftHasItems,
    });
    expect(decision).toEqual({ type: 'passthrough' });
    expect(readDraftHasItems).not.toHaveBeenCalled();
  });
});

describe('mutación del turno antes que checkout', () => {
  it('B1: remove success no delega', () => {
    expect(
      resolveCheckoutTurn({
        startCheckoutSession: true,
        startCheckoutReason: 'Cliente quiere finalizar el pedido.',
        cartMutatedThisTurn: toolMessageMutatedCart('remove_cart_item', true),
        draftHasItems: true,
      })
    ).toEqual({ type: 'defer_present_cart', draftHasItems: true });
  });

  it('B2: update de cantidad no delega', () => {
    expect(
      resolveCheckoutTurn({
        startCheckoutSession: true,
        startCheckoutReason: 'cerrar',
        cartMutatedThisTurn: toolMessageMutatedCart('update_cart_item_quantity', true),
        draftHasItems: true,
      })
    ).toEqual({ type: 'defer_present_cart', draftHasItems: true });
  });

  it('B3: add success no delega y la lectura puede ver el ítem', () => {
    expect(
      resolveCheckoutTurn({
        startCheckoutSession: true,
        startCheckoutReason: 'cerrar',
        cartMutatedThisTurn: toolMessageMutatedCart('add_cart_item', true),
        draftHasItems: true,
      })
    ).toEqual({ type: 'defer_present_cart', draftHasItems: true });
  });

  it('una mutación que dejó el carrito vacío tampoco delega ni finge empty_cart', () => {
    expect(
      resolveCheckoutTurn({
        startCheckoutSession: true,
        startCheckoutReason: 'cerrar',
        cartMutatedThisTurn: true,
        draftHasItems: false,
      })
    ).toEqual({ type: 'defer_present_cart', draftHasItems: false });
  });

  it('present_cart o un add fallido no cuentan como mutación', () => {
    expect(toolMessageMutatedCart('present_cart', true)).toBe(false);
    expect(toolMessageMutatedCart('add_cart_item', false)).toBe(false);
    expect(toolMessageMutatedCart('start_checkout_session', true)).toBe(false);
  });
});
