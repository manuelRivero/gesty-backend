/**
 * Indica que el usuario quiere actuar sobre la reserva (gestionar, cambiar, cancelar),
 * no solo ver datos. Si es true y hay reserva activa, conviene mostrar el menú de gestión.
 */
export function wantsReservationManagement(message: string): boolean {
  const t = message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (t.trim().length === 0) {
    return false;
  }

  if (
    /\b(modificar|gestionar|gestion|cancelar|editar|cambiar|reiniciar|administrar|actualizar|anular|reprogramar|dar\s+de\s+baja)\b/.test(
      t
    )
  ) {
    return true;
  }

  if (/\breserva(s)?\b/.test(t)) {
    if (
      /\b(quiero|necesito|puedo|debo|quisiera|deseo)\s+(modificar|gestionar|cancelar|editar|cambiar|anular)\b/.test(
        t
      )
    ) {
      return true;
    }
  }

  return false;
}
