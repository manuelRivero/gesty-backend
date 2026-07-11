/**
 * Mensaje determinístico para cuando el híbrido devuelve una señal de
 * re-entrada (`delegate_checkout`) en vez de texto durante una delegación
 * (`delegate_to_main`/`handback_to_main` inline) desde una sesión activa
 * (checkout/reservas/onboarding).
 *
 * Es el mecanismo anti-loop correcto — no se puede iniciar/tocar el checkout
 * mientras otra sesión lo tiene tomado — pero antes de H-07 la señal se
 * descartaba en silencio y el usuario recibía el texto residual del agente de
 * sesión, sin que nada explicara por qué su acción ("sumala y cobrame") no
 * tuvo efecto.
 */

export type SessionKind = 'checkout' | 'reservation' | 'onboarding';

const DISCARDED_REENTRY_MESSAGE: Record<SessionKind, string> = {
  checkout:
    'Ya estamos cerrando tu pedido 🛒 — terminemos este paso y después seguimos agregando o modificando.',
  reservation:
    'Estamos completando tu reserva 📅 — terminemos este paso y después vemos tu pedido.',
  onboarding:
    'Estamos guardando tu dirección 📍 — decime tu dirección o compartí tu ubicación y seguimos con lo demás.',
};

export function buildDiscardedReentryMessage(sessionKind: SessionKind): string {
  return DISCARDED_REENTRY_MESSAGE[sessionKind];
}
