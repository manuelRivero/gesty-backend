import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type {
  HandlerFollowUp,
  HandlerResult,
} from '../../controllers/webhook/types';
import type {
  WhatsAppInteractiveMessage,
  WhatsAppListMessage,
} from '../../domain/intent/whatsappTemplates';
import { ConversationIntent } from '../../types/conversationIntent';
import { getSmallChatLlm } from '../../config/llm';
import {
  parseBotUserMessage,
  rebuildBotUserMessage,
} from '../productQuery/utils';

const HUMANIZE_TIMEOUT_MS = 1500;

/** Intents cuyo body ya lo genera un LLM en el handler; no re-humanizar. */
const INTENTS_WITH_LLM_BODY = new Set<string>([
  ConversationIntent.UNKNOWN,
  ConversationIntent.PRODUCT_QUERY,
  ConversationIntent.PRODUCT_ATTRIBUTE_QUESTION,
]);

const SYSTEM_PROMPT = `Sos un asistente de un restaurante por WhatsApp. Reescribí el cuerpo del mensaje con tono cálido, natural y breve, como un bot inteligente que conversa.

Reglas estrictas:
- Devolvé SOLO el cuerpo reescrito, sin título, sin emoji 🤖, sin markdown de encabezado.
- Mantené el mismo significado e información factual (números, fechas, precios, nombres de productos, instrucciones obligatorias).
- Conservá las negritas de WhatsApp con un solo asterisco a cada lado (*así*).
- No inventes datos ni agregues preguntas nuevas salvo un cierre muy breve si encaja.
- Español rioplatense (vos), máximo 4 oraciones cortas.`;

export async function humanizeBotBody(rawBody: string): Promise<string> {
  const trimmed = rawBody.trim();
  if (!trimmed) return trimmed;

  const llm = getSmallChatLlm();
  try {
    const response = await llm.invoke(
      [
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(
          `Reescribí este cuerpo de mensaje:\n\n${trimmed}`
        ),
      ],
      { signal: AbortSignal.timeout(HUMANIZE_TIMEOUT_MS) }
    );

    const content =
      typeof response.content === 'string'
        ? response.content
        : Array.isArray(response.content)
          ? response.content
              .map((part) =>
                typeof part === 'string'
                  ? part
                  : ((part as { text?: string }).text ?? '')
              )
              .join('')
          : '';

    const rewritten = content.trim();
    return rewritten || trimmed;
  } catch (err) {
    console.warn('[humanizeBotBody] fallback to original body:', err);
    return trimmed;
  }
}

async function humanizeBotFormattedText(text: string): Promise<string> {
  const parsed = parseBotUserMessage(text);
  if (!parsed) return text;

  const humanizedBody = await humanizeBotBody(parsed.body);
  if (humanizedBody === parsed.body.trim()) return text;

  return rebuildBotUserMessage(parsed.title, parsed.emoji, humanizedBody);
}

async function humanizeListMessage(
  listMessage: WhatsAppListMessage
): Promise<WhatsAppListMessage> {
  const humanizedBodyText = await humanizeBotFormattedText(listMessage.body.text);
  if (humanizedBodyText === listMessage.body.text) return listMessage;

  return {
    ...listMessage,
    body: { text: humanizedBodyText },
  };
}

async function humanizeInteractiveMessage(
  message: WhatsAppInteractiveMessage
): Promise<WhatsAppInteractiveMessage> {
  const humanizedBodyText = await humanizeBotFormattedText(
    message.interactive.body.text
  );
  if (humanizedBodyText === message.interactive.body.text) return message;

  return {
    ...message,
    interactive: {
      ...message.interactive,
      body: { text: humanizedBodyText },
    },
  };
}

async function humanizeFollowUp(followUp: HandlerFollowUp): Promise<HandlerFollowUp> {
  if (followUp.type === 'text') {
    const message = await humanizeBotFormattedText(followUp.message);
    return message === followUp.message ? followUp : { ...followUp, message };
  }

  if (followUp.type === 'list') {
    const listMessage = await humanizeListMessage(followUp.listMessage);
    return listMessage === followUp.listMessage
      ? followUp
      : { ...followUp, listMessage };
  }

  if (followUp.type === 'interactive') {
    const message = await humanizeInteractiveMessage(followUp.message);
    return message === followUp.message ? followUp : { ...followUp, message };
  }

  return followUp;
}

export type HumanizeHandlerResultOptions = {
  enabled: boolean;
  intent?: string | null;
};

/**
 * Humaniza solo el body de mensajes con formato estándar del bot (🤖 + título + cuerpo).
 * Se aplica al content principal y a followUps de texto/lista/interactive.
 */
export async function humanizeHandlerResult(
  result: HandlerResult,
  options: HumanizeHandlerResultOptions
): Promise<HandlerResult> {
  if (!options.enabled || result.skipBodyHumanization) {
    return result;
  }

  const intent = options.intent ?? null;
  if (intent && INTENTS_WITH_LLM_BODY.has(intent)) {
    return result;
  }

  let next: HandlerResult = result;

  if (!result.isInteractive && typeof result.content === 'string') {
    const content = await humanizeBotFormattedText(result.content);
    if (content !== result.content) {
      next = { ...next, content };
    }
  } else if (result.isInteractive && result.content) {
    const content = result.content as WhatsAppListMessage | WhatsAppInteractiveMessage;
    if ((content as WhatsAppListMessage).type === 'list') {
      const listMessage = await humanizeListMessage(content as WhatsAppListMessage);
      if (listMessage !== content) {
        next = { ...next, content: listMessage };
      }
    } else {
      const interactiveMessage = await humanizeInteractiveMessage(
        content as WhatsAppInteractiveMessage
      );
      if (interactiveMessage !== content) {
        next = { ...next, content: interactiveMessage };
      }
    }
  }

  if (!result.followUps?.length) {
    return next;
  }

  const followUps = await Promise.all(result.followUps.map(humanizeFollowUp));
  const followUpsChanged = followUps.some(
    (followUp, index) => followUp !== result.followUps![index]
  );

  return followUpsChanged ? { ...next, followUps } : next;
}
