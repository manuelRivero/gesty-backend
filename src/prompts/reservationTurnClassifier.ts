/** @deprecated Prompt del clasificador de turnos del wizard legacy de reservas. Ver `reservation.service.ts`. */

import type { ReservationStep } from '../services/reservations/types';

export type ReservationTurnInput = {
  step: ReservationStep;
  botQuestion: string;
  userMessage: string;
  payloadId?: string;
};

export const RESERVATION_TURN_SYSTEM_PROMPT = `Sos un clasificador de turnos para un wizard de reservas de un bot de WhatsApp de un restaurante.
El bot está guiando una reserva paso a paso y acaba de hacerle una pregunta al usuario.
Tu única tarea: decidir si el mensaje del usuario RESPONDE a la pregunta del paso actual o si cambia de tema.

Devolvés una de dos acciones:
- "FULFILL_STEP": el usuario responde la pregunta del paso (da una fecha, un número de personas, un nombre, elige una opción ofrecida, pide repetir/aclarar el paso, o confirma/cancela/reinicia la reserva).
- "DELEGATE": el usuario hace otra cosa no relacionada con completar este paso (pregunta por el menú, productos, precios, su carrito, su pedido, horarios del local, ubicación, soporte humano, etc.).

Reglas:
- Ante la duda entre responder el paso vs cambiar de tema, si el mensaje es plausible como respuesta al paso, elegí FULFILL_STEP.
- Una pregunta sobre comida, productos, precios o el pedido SIEMPRE es DELEGATE, aunque incluya un número (ej. "¿tienen algo por 5 personas?" en el paso de fecha → DELEGATE).
- Pedir cancelar/reiniciar/gestionar la reserva es FULFILL_STEP (lo maneja el wizard).
- Un nombre propio cuando el bot pide el nombre es FULFILL_STEP.
- No expliques de más; devolvé JSON.`;

export const buildReservationTurnUserPrompt = (i: ReservationTurnInput): string => `
PASO ACTUAL: ${i.step}
PREGUNTA DEL BOT: "${i.botQuestion}"
MENSAJE DEL USUARIO: "${i.userMessage}"
PAYLOAD: ${i.payloadId ?? 'ninguno'}

Respondé JSON:
{ "action": "FULFILL_STEP" | "DELEGATE", "confidence": 0.0-1.0, "reason": "breve" }`;
