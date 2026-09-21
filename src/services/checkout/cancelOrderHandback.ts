/**
 * Detecta handback de checkout cuyo motivo es cancelar el pedido (wipe total),
 * no solo salir a editar el carrito / ver menú.
 *
 * El nodo aplica el mismo efecto que CANCEL_ORDER / cancel_order — no deja el
 * wipe al ReAct del híbrido (§3.11 asimetría botón vs tipable).
 */

const CANCEL_ORDER_REASON_RE =
  /cancel(?:a|á|ar).{0,40}(?:pedido|carrito|todo)|borr(?:a|á|ar).{0,20}carrito|no quiero (?:el )?pedido/i;

export const isCancelOrderHandback = (params: {
  reason?: string | null;
  userMessage?: string | null;
}): boolean => {
  const reason = params.reason?.trim() ?? '';
  if (reason && CANCEL_ORDER_REASON_RE.test(reason)) return true;
  const msg = params.userMessage?.trim() ?? '';
  if (msg && CANCEL_ORDER_REASON_RE.test(msg)) return true;
  return false;
};
