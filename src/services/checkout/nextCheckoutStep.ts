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

export type CheckoutStep = 'fulfillment' | 'address' | 'name' | 'payment' | 'done';

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
  return 'done';
}
