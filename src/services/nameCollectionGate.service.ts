import { formatBotUserMessage } from './productQuery/utils';

/** Formato estándar del bot: 🤖, título en negrita, cuerpo con guía clara. */
export const NAME_COLLECTION_PROMPT_MESSAGE = formatBotUserMessage(
  'Tu nombre',
  '📝',
  'Por cierto, ¿me podrías decir tu *nombre* para registrarte?'
);
