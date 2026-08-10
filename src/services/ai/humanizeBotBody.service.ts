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
import { buildHumanizeSystemPrompt } from '../../prompts/botPersonality';
import {
  parseBotUserMessage,
  rebuildBotUserMessage,
} from '../productQuery/utils';
import { normalizeWhatsAppBoldMarkers } from '../../utils/whatsappBold';

const HUMANIZE_TIMEOUT_MS = 1500;

/** Intents cuyo body ya lo genera un LLM en el handler; no re-humanizar. */
const INTENTS_WITH_LLM_BODY = new Set<string>([
  ConversationIntent.UNKNOWN,
  ConversationIntent.PRODUCT_QUERY,
  ConversationIntent.PRODUCT_ATTRIBUTE_QUESTION,
]);

const SYSTEM_PROMPT = buildHumanizeSystemPrompt();

export async function humanizeBotBody(
  rawBody: string,
  personalityPromptText?: string
): Promise<string> {
  const trimmed = rawBody.trim();
  if (!trimmed) return trimmed;

  const systemPrompt = personalityPromptText
    ? buildHumanizeSystemPrompt(personalityPromptText)
    : SYSTEM_PROMPT;

  const llm = getSmallChatLlm();
  try {
    const response = await llm.invoke(
      [
        new SystemMessage(systemPrompt),
        new HumanMessage(
          `Reescribí SOLO el tono de este cuerpo. Conservá viñetas, negritas, saltos de línea y el mismo contenido factual:\n\n${trimmed}`
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

    const rewritten = normalizeWhatsAppBoldMarkers(content.trim() || trimmed);
    return rewritten || trimmed;
  } catch (err) {
    console.warn('[humanizeBotBody] fallback to original body:', err);
    return normalizeWhatsAppBoldMarkers(trimmed);
  }
}

async function humanizeBotFormattedText(
  text: string,
  personalityPromptText?: string
): Promise<string> {
  const parsed = parseBotUserMessage(text);
  if (parsed) {
    const humanizedBody = await humanizeBotBody(parsed.body, personalityPromptText);
    if (humanizedBody === parsed.body.trim()) return text;
    return rebuildBotUserMessage(parsed.title, parsed.emoji, humanizedBody);
  }

  // Cuerpos planos (p. ej. listas con título en header): humanizar el body tal cual.
  const trimmed = text.trim();
  if (!trimmed) return text;
  return humanizeBotBody(trimmed, personalityPromptText);
}

async function humanizeListMessage(
  listMessage: WhatsAppListMessage,
  personalityPromptText?: string
): Promise<WhatsAppListMessage> {
  const humanizedBodyText = await humanizeBotFormattedText(
    listMessage.body.text,
    personalityPromptText
  );
  if (humanizedBodyText === listMessage.body.text) return listMessage;

  return {
    ...listMessage,
    body: { text: humanizedBodyText },
  };
}

async function humanizeInteractiveMessage(
  message: WhatsAppInteractiveMessage,
  personalityPromptText?: string
): Promise<WhatsAppInteractiveMessage> {
  const humanizedBodyText = await humanizeBotFormattedText(
    message.interactive.body.text,
    personalityPromptText
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

async function humanizeFollowUp(
  followUp: HandlerFollowUp,
  personalityPromptText?: string
): Promise<HandlerFollowUp> {
  if (followUp.type === 'text') {
    const message = await humanizeBotFormattedText(
      followUp.message,
      personalityPromptText
    );
    return message === followUp.message ? followUp : { ...followUp, message };
  }

  if (followUp.type === 'list') {
    const listMessage = await humanizeListMessage(
      followUp.listMessage,
      personalityPromptText
    );
    return listMessage === followUp.listMessage
      ? followUp
      : { ...followUp, listMessage };
  }

  if (followUp.type === 'interactive') {
    const message = await humanizeInteractiveMessage(
      followUp.message,
      personalityPromptText
    );
    return message === followUp.message ? followUp : { ...followUp, message };
  }

  return followUp;
}

export type HumanizeHandlerResultOptions = {
  enabled: boolean;
  intent?: string | null;
  personalityPromptText?: string;
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

  const personalityPromptText = options.personalityPromptText;
  let next: HandlerResult = result;

  if (!result.isInteractive && typeof result.content === 'string') {
    const content = await humanizeBotFormattedText(
      result.content,
      personalityPromptText
    );
    if (content !== result.content) {
      next = { ...next, content };
    }
  } else if (result.isInteractive && result.content) {
    const content = result.content as WhatsAppListMessage | WhatsAppInteractiveMessage;
    if ((content as WhatsAppListMessage).type === 'list') {
      const listMessage = await humanizeListMessage(
        content as WhatsAppListMessage,
        personalityPromptText
      );
      if (listMessage !== content) {
        next = { ...next, content: listMessage };
      }
    } else {
      const interactiveMessage = await humanizeInteractiveMessage(
        content as WhatsAppInteractiveMessage,
        personalityPromptText
      );
      if (interactiveMessage !== content) {
        next = { ...next, content: interactiveMessage };
      }
    }
  }

  if (!result.followUps?.length) {
    return next;
  }

  const followUps = await Promise.all(
    result.followUps.map((followUp) =>
      humanizeFollowUp(followUp, personalityPromptText)
    )
  );
  const followUpsChanged = followUps.some(
    (followUp, index) => followUp !== result.followUps![index]
  );

  return followUpsChanged ? { ...next, followUps } : next;
}
