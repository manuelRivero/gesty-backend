import { z } from 'zod';
import {
  PAYMENT_METHOD_PROMPT_BOT_MESSAGE,
  FULFILLMENT_TYPE_PROMPT_BOT_MESSAGE,
} from '../productQuery/botMessages';

export type CheckoutPendingAction = 'payment_method' | 'fulfillment_type';

export const PaymentMethodPendingSchema = z.object({
  method: z.enum(['cash', 'online']),
});

export type PaymentMethodPendingValue = z.infer<typeof PaymentMethodPendingSchema>;

export const FulfillmentTypePendingSchema = z.object({
  type: z.enum(['DELIVERY', 'TAKE_AWAY']),
});

export type FulfillmentTypePendingValue = z.infer<typeof FulfillmentTypePendingSchema>;

export type CheckoutPendingActionConfig<T = unknown> = {
  pendingAction: CheckoutPendingAction;
  defaultQuestion: string;
  schema: z.ZodType<T>;
  valueHints: string;
  actionDescription: string;
};

const PAYMENT_METHOD_CONFIG: CheckoutPendingActionConfig<PaymentMethodPendingValue> = {
  pendingAction: 'payment_method',
  defaultQuestion: PAYMENT_METHOD_PROMPT_BOT_MESSAGE,
  schema: PaymentMethodPendingSchema,
  valueHints: `{
  "method": "cash" | "online"
}
- cash: efectivo, en efectivo, cash, en mano, pago al recibir
- online: online, tarjeta, mercado pago, digital, transferencia, con tarjeta`,
  actionDescription:
    'El usuario debe elegir cómo pagar el pedido: efectivo al recibir o pago online con tarjeta/Mercado Pago.',
};

const FULFILLMENT_TYPE_CONFIG: CheckoutPendingActionConfig<FulfillmentTypePendingValue> = {
  pendingAction: 'fulfillment_type',
  defaultQuestion: FULFILLMENT_TYPE_PROMPT_BOT_MESSAGE,
  schema: FulfillmentTypePendingSchema,
  valueHints: `{
  "type": "DELIVERY" | "TAKE_AWAY"
}
- DELIVERY: en casa, a domicilio, delivery, envío, domicilio
- TAKE_AWAY: retiro, take away, paso a buscar, retiro en local, retirar en local`,
  actionDescription:
    'El usuario debe elegir si quiere delivery a domicilio o retiro en el local.',
};

const REGISTRY: Record<CheckoutPendingAction, CheckoutPendingActionConfig> = {
  payment_method: PAYMENT_METHOD_CONFIG,
  fulfillment_type: FULFILLMENT_TYPE_CONFIG,
};

export function getCheckoutPendingActionConfig(
  action: string
): CheckoutPendingActionConfig | null {
  if (action === 'payment_method' || action === 'fulfillment_type') {
    return REGISTRY[action];
  }
  return null;
}
