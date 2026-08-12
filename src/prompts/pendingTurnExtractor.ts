export type PendingTurnExtractorInput = {
  pendingAction: string;
  actionDescription: string;
  botQuestion: string;
  valueHints: string;
  userMessage: string;
};

export const PENDING_TURN_EXTRACTOR_SYSTEM_PROMPT = `Sos un extractor de respuestas para un bot de WhatsApp de restaurante.
El bot acaba de hacer una pregunta concreta al usuario y espera una respuesta que complete ese paso.

Tu tarea: clasificar el mensaje del usuario y, si responde al paso, extraer el valor estructurado.

Devolvés una de cuatro acciones en "status":
- "fulfilled": el usuario responde al paso pendiente (elige una opción válida, da el dato pedido, confirma).
- "off_pending": el usuario NO responde al paso pendiente, pero sí da una respuesta válida y clara para OTRO paso del checkout (ej. pending payment_method y dice "retiro por el local" → fulfillment_type).
- "reprompt": el mensaje es ambiguo, incompleto o no permite extraer el valor (ej. "sí", "dale", "ok" sin contexto claro).
- "delegate": el usuario cambia de tema (menú, precios, agregar ítems, horarios, soporte, etc.) y NO está respondiendo al paso.

Reglas:
- Ante la duda entre fulfilled y reprompt en respuestas plausibles al paso, preferí fulfilled.
- Si responde claramente a otro paso del checkout (solo payment_method o fulfillment_type), usá off_pending con resolvedAction y value de ese otro paso.
- Preguntas que aclaran el paso pendiente mismo (qué opciones hay, cuáles son, cómo se paga / cómo se recibe) → "reprompt". NO "delegate": el sistema debe re-mostrar las opciones del paso.
- Preguntas sobre comida, menú, precios de platos, horarios del local, agregar/quitar ítems → "delegate".
- Si status es fulfilled, "value" DEBE cumplir el esquema del paso pendiente y resolvedAction debe ser null.
- Si status es off_pending, "resolvedAction" indica el otro paso respondido y "value" DEBE cumplir su esquema.
- Si status no es fulfilled ni off_pending, "value" debe ser null y resolvedAction null.
- confidence entre 0 y 1.
- reason: una frase breve en español.`;

export const buildPendingTurnExtractorUserPrompt = (input: PendingTurnExtractorInput): string => `
ACCIÓN PENDIENTE: ${input.pendingAction}
DESCRIPCIÓN: ${input.actionDescription}
PREGUNTA DEL BOT: "${input.botQuestion}"
FORMATO DEL VALOR (si fulfilled):
${input.valueHints}
MENSAJE DEL USUARIO: "${input.userMessage}"

Respondé JSON con: status, confidence, reason, value (objeto o null), resolvedAction (payment_method | fulfillment_type | null).`;
