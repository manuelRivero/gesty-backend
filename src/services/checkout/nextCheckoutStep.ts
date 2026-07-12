/**
 * Fuente de verdad determinística del orden del checkout (Tarea 4.1 / H-10).
 *
 * El orden entrega → dirección → nombre → pago vivía solo en prosa del
 * system prompt del agente, con `validateCheckoutResponse` cubriendo apenas
 * dos combinaciones a mano (payment sin fulfillment). Esta función deriva el
 * paso real desde el estado consultable del draft/cliente — el mismo patrón
 * que ya usa `nextReservationDraftQuestion` para el agente de reservas — para
 * que el LLM proponga y la máquina disponga, no al revés.
 */

export type CheckoutStep = 'fulfillment' | 'address' | 'name' | 'payment' | 'confirm' | 'done';

export interface CheckoutStepState {
  fulfillmentType: 'DELIVERY' | 'TAKE_AWAY' | null;
  hasAddress: boolean;
  isInCoverage: boolean;
  customerName: string | null;
  paymentMethod: 'cash' | 'online' | null;
}

export interface CheckoutStepConfig {
  deliveryEnabled: boolean;
  takeawayEnabled: boolean;
}

/**
 * `confirm`: el método de pago ya está elegido (Fact) pero la sesión de
 * checkout sigue activa — significa que el pedido todavía no se creó. La
 * orden se ejecuta recién cuando el cliente confirma el resumen final
 * (`resolve_order_confirmation`); hasta entonces, elegir el método NUNCA
 * dispara el cobro por sí solo. Cancelar la confirmación vuelve a `payment`
 * (se limpia `paymentMethod` en el draft) — no hace falta un flag aparte.
 */
export function nextCheckoutStep(
  state: CheckoutStepState,
  _config: CheckoutStepConfig
): CheckoutStep {
  if (!state.fulfillmentType) return 'fulfillment';
  if (state.fulfillmentType === 'DELIVERY' && (!state.hasAddress || !state.isInCoverage)) {
    return 'address';
  }
  if (!state.customerName?.trim()) return 'name';
  if (!state.paymentMethod) return 'payment';
  return 'confirm';
}
