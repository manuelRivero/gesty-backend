/**
 * Agente ReAct del dueño: métricas en lenguaje natural.
 *
 * No es un agente de sesión (no recolecta Facts, no hay nextStep).
 * Ownership = identidad del teléfono. Ver PLAN-ACCION-OWNER-ASSISTANT.md.
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { HumanMessage } from '@langchain/core/messages';
import { getReactReasonerLlm } from '../config/llm';
import { buildAgentHistoryMessages } from './conversationHistory';
import { buildOwnerAssistantAgentSystemPrompt } from '../prompts/botPersonality';
import { resolvePersonalityForBusiness } from '../services/botPersonality.service';
import { allOwnerAssistantTools } from '../tools/ownerAssistant';
import { formatBotUserMessage } from '../services/productQuery/utils';
import { calendarDateInTz } from '../services/ownerAssistant/resolveOwnerPeriod';
import {
  appendOwnerShortcutsToMessage,
  buildOwnerAmbiguityFallbackBody,
  buildOwnerShortcutLedgerLines,
  buildOwnerShortcutsBody,
  extractOwnerToolInvocations,
  resolveUsedOwnerShortcutIds,
} from '../services/ownerAssistant/ownerShortcuts.service';
import type { EnrichedContext } from '../controllers/webhook/types';

let cachedAgents = new Map<string, ReturnType<typeof createReactAgent>>();

const buildAgent = (personalityId: string, personalityPrompt: string) => {
  const cacheKey = `owner_assistant:${personalityId}`;
  let agent = cachedAgents.get(cacheKey);
  if (!agent) {
    agent = createReactAgent({
      llm: getReactReasonerLlm(),
      tools: allOwnerAssistantTools,
      prompt: buildOwnerAssistantAgentSystemPrompt(personalityPrompt),
    });
    cachedAgents.set(cacheKey, agent);
  }
  return agent;
};

export const resetOwnerAssistantAgentCacheForTesting = (): void => {
  cachedAgents = new Map();
};

const WEEKDAYS_ES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
];

const formatNowLabel = (tz: string, now = new Date()): string => {
  const date = calendarDateInTz(tz, now);
  let time = '';
  let weekday = '';
  try {
    time = new Intl.DateTimeFormat('es-AR', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);
    weekday = new Intl.DateTimeFormat('es-AR', {
      timeZone: tz,
      weekday: 'long',
    }).format(now);
  } catch {
    time = new Intl.DateTimeFormat('es-AR', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);
    weekday = WEEKDAYS_ES[now.getUTCDay()] ?? '';
  }
  return `${weekday} ${date} ${time}`.trim();
};

const buildOwnerAssistantContextMessage = (ctx: EnrichedContext): string => {
  const userMsg = ctx.message?.text?.body ?? '';
  const business =
    typeof ctx.business === 'object' && ctx.business
      ? (ctx.business as { name?: string; timezone?: string })
      : {};
  const tz = business.timezone || 'America/Argentina/Buenos_Aires';
  const name = business.name?.trim() || 'el local';

  const lines = [
    '[ESTADO DEL OWNER]',
    `- Negocio: ${name}`,
    `- Fecha/hora local: ${formatNowLabel(tz)}`,
    `- Timezone: ${tz}`,
    '- Canal: asistente operativo del dueño (no el bot de clientes)',
    '- Acción esperada: interpretar la consulta y llamar la tool del nivel de detalle pedido. No inventar números.',
    ...buildOwnerShortcutLedgerLines(),
    '',
    userMsg,
  ];
  return lines.join('\n');
};

const extractFinalText = (result: unknown): string | null => {
  if (typeof result !== 'object' || result === null) return null;
  const messages = (result as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1] as { content?: unknown };
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return (
      last.content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (typeof part === 'object' && part && 'text' in part) {
            return String((part as { text: unknown }).text ?? '');
          }
          return '';
        })
        .join('')
        .trim() || null
    );
  }
  return null;
};

const withOwnerShortcuts = (
  formattedMessage: string,
  messages: unknown[]
): string => {
  const invocations = extractOwnerToolInvocations(messages);
  const used = resolveUsedOwnerShortcutIds(invocations);
  const mode = invocations.length === 0 ? 'menu' : 'remaining';
  const shortcutsBody = buildOwnerShortcutsBody({
    usedActionIds: used,
    mode,
  });
  return appendOwnerShortcutsToMessage(formattedMessage, shortcutsBody);
};

export interface OwnerAssistantAgentResult {
  text: string;
  signals: Record<string, never>;
}

export const runOwnerAssistantAgent = async (
  ctx: EnrichedContext
): Promise<OwnerAssistantAgentResult | null> => {
  const businessId =
    typeof ctx.business === 'object' && ctx.business
      ? (ctx.business as { id: string }).id
      : '';
  if (!businessId) return null;

  const { id: personalityId, promptText } =
    await resolvePersonalityForBusiness(businessId);
  const agent = buildAgent(personalityId, promptText);

  const customerId =
    typeof ctx.customer === 'object' && ctx.customer
      ? (ctx.customer as { id: string }).id
      : '';
  const customerPhone =
    typeof ctx.customer === 'object' && ctx.customer
      ? (ctx.customer as { phone_number?: string }).phone_number ?? ctx.to
      : ctx.to;
  const conversationId = ctx.conversationId;
  const conversationStartedAt =
    typeof ctx.conversation === 'object' && ctx.conversation
      ? (ctx.conversation as { started_at?: Date }).started_at?.toISOString() ?? ''
      : '';

  const contextMessage = buildOwnerAssistantContextMessage(ctx);

  const history = await buildAgentHistoryMessages({
    conversationId,
    startedAt:
      typeof ctx.conversation === 'object' && ctx.conversation
        ? (ctx.conversation as { started_at?: Date }).started_at ?? null
        : null,
    currentMessageId: ctx.message?.id ?? null,
  });

  const out = await agent.invoke(
    { messages: [...history, new HumanMessage(contextMessage)] },
    {
      recursionLimit: 8,
      configurable: {
        businessId,
        customerId,
        customerPhone,
        conversationId,
        conversationStartedAt,
      },
    }
  );

  const messages = (out as { messages?: unknown[] }).messages ?? [];
  const rawText = extractFinalText(out);

  if (!rawText) {
    return {
      text: formatBotUserMessage(
        'Tu local',
        '📊',
        buildOwnerAmbiguityFallbackBody()
      ),
      signals: {},
    };
  }

  const formatted = rawText.startsWith('🤖')
    ? rawText
    : formatBotUserMessage('Tu local', '📊', rawText);

  return {
    text: withOwnerShortcuts(formatted, messages),
    signals: {},
  };
};
