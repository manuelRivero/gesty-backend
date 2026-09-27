/**
 * `handback_to_main` solo sale de checkout. El wipe no se infiere del reason
 * ni del mensaje: hace falta la señal estructurada `cancel_order`.
 * Los botones CANCEL_ORDER / CANCEL_CHECKOUT siguen en su payload, aparte.
 */

export const isStructuredOrderCancel = (signal: string | null | undefined): boolean =>
  signal === 'cancel_order';

/** Texto libre de handback o del usuario no autoriza borrar el pedido. */
export const isCancelOrderHandback = (_params: {
  reason?: string | null;
  userMessage?: string | null;
}): boolean => false;
