/**
 * Después del invoke: la tool `start_checkout_session` solo pide checkout.
 * El carrito se lee una vez, con las tools del turno ya terminadas.
 * Una mutación exitosa del mismo turno no delega.
 */

export const CHECKOUT_EMPTY_CART_MESSAGE =
  'El carrito está vacío; no se puede iniciar checkout.';

export type CheckoutTurnAction =
  | { type: 'passthrough' }
  | { type: 'delegate'; reason: string | null }
  | { type: 'empty_cart' }
  | { type: 'defer_present_cart'; draftHasItems: boolean };

const CART_MUTATION_TOOLS = new Set([
  'add_cart_item',
  'update_cart_item_quantity',
  'remove_cart_item',
]);

/** ToolMessage estructurado: success de add, cantidad o quita. No mira texto. */
export function toolMessageMutatedCart(name: unknown, success: unknown): boolean {
  return success === true && typeof name === 'string' && CART_MUTATION_TOOLS.has(name);
}

export function resolveCheckoutTurn(input: {
  startCheckoutSession: boolean;
  startCheckoutReason: string | null;
  cartMutatedThisTurn: boolean;
  draftHasItems: boolean;
}): CheckoutTurnAction {
  if (!input.startCheckoutSession) return { type: 'passthrough' };
  if (input.cartMutatedThisTurn) {
    return { type: 'defer_present_cart', draftHasItems: input.draftHasItems };
  }
  if (input.draftHasItems) {
    return { type: 'delegate', reason: input.startCheckoutReason };
  }
  return { type: 'empty_cart' };
}

/** Una sola lectura, y solo si este turno pidió checkout. */
export async function applyCheckoutTurnGate(params: {
  startCheckoutSession: boolean;
  startCheckoutReason: string | null;
  cartMutatedThisTurn: boolean;
  readDraftHasItems: () => Promise<boolean>;
}): Promise<CheckoutTurnAction> {
  if (!params.startCheckoutSession) return { type: 'passthrough' };
  const draftHasItems = await params.readDraftHasItems();
  return resolveCheckoutTurn({
    startCheckoutSession: true,
    startCheckoutReason: params.startCheckoutReason,
    cartMutatedThisTurn: params.cartMutatedThisTurn,
    draftHasItems,
  });
}
