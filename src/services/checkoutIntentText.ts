/**
 * Señales en texto libre de que el usuario quiere cerrar el pedido y pagar.
 * Usado por el clasificador de intents antes del LLM (atajo determinístico).
 */
export function wantsCheckout(message: string): boolean {
  const t = message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (!t) return false;

  // Ver / modificar carrito — no es checkout
  if (
    /\b(modificar|editar|cambiar|quitar|sacar|eliminar|remover|ver|mostrar|revisar)\b/.test(
      t
    ) &&
    /\b(pedido|carrito|orden|compra)\b/.test(t)
  ) {
    return false;
  }

  // Consulta de monto o método — no es cerrar pedido
  if (/\b(cuanto|cuanto sale|total|precio)\b/.test(t) && !/\b(quiero|listo|vamos|dale)\b/.test(t)) {
    return false;
  }
  if (/\b(como|metodo|forma)\b/.test(t) && /\bpag(o|ar)\b/.test(t)) {
    return false;
  }

  if (/^pagar[.!]?$/.test(t)) return true;
  if (
    /\b(quiero|necesito|voy a|deseo|listo para|pasemos a)\s+(pagar|finalizar|cerrar)\b/.test(t)
  ) {
    return true;
  }
  if (/\b(finalizar|cerrar|completar)\s+(el\s+)?(pedido|compra|orden)\b/.test(t)) {
    return true;
  }
  if (/\b(pagar|pago)\s+(el\s+)?(pedido|compra|orden|ya|ahora)\b/.test(t)) {
    return true;
  }
  if (/\b(confirmar|cerrar)\s+(el\s+)?(pedido|compra)\b/.test(t)) {
    return true;
  }
  if (/\bcheckout\b/.test(t)) return true;

  return false;
}
