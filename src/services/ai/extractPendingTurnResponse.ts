import { z } from 'zod';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { getIntentDetectorLlm } from '../../config/llm';
import {
  PENDING_TURN_EXTRACTOR_SYSTEM_PROMPT,
  buildPendingTurnExtractorUserPrompt,
} from '../../prompts/pendingTurnExtractor';
import type { PaymentMethodPendingValue } from '../checkout/pendingActionRegistry';

export type PendingTurnStatus = 'fulfilled' | 'reprompt' | 'delegate';

export type PendingTurnExtractionResult<T> = {
  status: PendingTurnStatus;
  value: T | null;
  confidence: number;
  reason: string | null;
  source: 'deterministic' | 'llm' | 'fallback';
};

const PendingTurnResponseSchema = z.object({
  status: z.enum(['fulfilled', 'reprompt', 'delegate']),
  confidence: z.number().min(0).max(1),
  reason: z.string().nullable(),
  value: z.unknown().nullable(),
});

const normalizeText = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

/** Atajos determinísticos triviales antes del LLM. */
function tryDeterministicExtraction<T>(params: {
  pendingAction: string;
  userMessage: string;
  schema: z.ZodType<T>;
}): PendingTurnExtractionResult<T> | null {
  const text = normalizeText(params.userMessage);
  if (!text) {
    return {
      status: 'reprompt',
      value: null,
      confidence: 1,
      reason: 'mensaje_vacio',
      source: 'deterministic',
    };
  }

  if (params.pendingAction === 'payment_method') {
    const cashPattern =
      /^(efectivo|cash|en efectivo|en mano|pago en efectivo|con efectivo)[.!]?$/;
    const onlinePattern =
      /^(online|tarjeta|mercado pago|mercadopago|pago online|con tarjeta|digital)[.!]?$/;

    if (cashPattern.test(text)) {
      const value = { method: 'cash' as const };
      const parsed = params.schema.safeParse(value);
      if (parsed.success) {
        return {
          status: 'fulfilled',
          value: parsed.data,
          confidence: 0.98,
          reason: 'efectivo_explicito',
          source: 'deterministic',
        };
      }
    }
    if (onlinePattern.test(text)) {
      const value = { method: 'online' as const };
      const parsed = params.schema.safeParse(value);
      if (parsed.success) {
        return {
          status: 'fulfilled',
          value: parsed.data,
          confidence: 0.98,
          reason: 'online_explicito',
          source: 'deterministic',
        };
      }
    }

    if (
      /\b(menu|menú|precio|horario|agregar|quitar|modificar|carrito|reserva)\b/.test(text)
    ) {
      return {
        status: 'delegate',
        value: null,
        confidence: 0.9,
        reason: 'cambio_de_tema',
        source: 'deterministic',
      };
    }
  }

  if (params.pendingAction === 'fulfillment_type') {
    const deliveryPatterns = [
      /^(en casa|a domicilio|domicilio|delivery|envio|envío)[.!]?$/,
      /\b(envio|envío)\s+a\s+domicilio\b/,
      /\b(quiero|necesito)\s+(delivery|domicilio)\b/,
    ];
    const takeawayPatterns = [
      /^(retiro|take away|takeaway|paso a buscar|retiro en local|retirar en local)[.!]?$/,
      /\b(quiero|voy a)\s+(retirar|buscar)\b/,
    ];

    for (const pattern of deliveryPatterns) {
      if (pattern.test(text)) {
        const value = { type: 'DELIVERY' as const };
        const parsed = params.schema.safeParse(value);
        if (parsed.success) {
          return {
            status: 'fulfilled',
            value: parsed.data,
            confidence: 0.98,
            reason: 'delivery_explicito',
            source: 'deterministic',
          };
        }
      }
    }
    for (const pattern of takeawayPatterns) {
      if (pattern.test(text)) {
        const value = { type: 'TAKE_AWAY' as const };
        const parsed = params.schema.safeParse(value);
        if (parsed.success) {
          return {
            status: 'fulfilled',
            value: parsed.data,
            confidence: 0.98,
            reason: 'takeaway_explicito',
            source: 'deterministic',
          };
        }
      }
    }

    if (
      /\b(menu|menú|precio|horario|agregar|quitar|modificar|carrito|reserva|pagar)\b/.test(text)
    ) {
      return {
        status: 'delegate',
        value: null,
        confidence: 0.9,
        reason: 'cambio_de_tema',
        source: 'deterministic',
      };
    }
  }

  return null;
}

export async function extractPendingTurnResponse<T>(params: {
  userMessage: string;
  pendingAction: string;
  botQuestion: string;
  schema: z.ZodType<T>;
  valueHints: string;
  actionDescription: string;
}): Promise<PendingTurnExtractionResult<T>> {
  const trimmed = params.userMessage.trim();
  if (!trimmed) {
    return {
      status: 'reprompt',
      value: null,
      confidence: 1,
      reason: 'mensaje_vacio',
      source: 'deterministic',
    };
  }

  const deterministic = tryDeterministicExtraction({
    pendingAction: params.pendingAction,
    userMessage: trimmed,
    schema: params.schema,
  });
  if (deterministic) {
    return deterministic;
  }

  try {
    const llm = getIntentDetectorLlm().withStructuredOutput(PendingTurnResponseSchema);
    const parsed = await llm.invoke(
      [
        new SystemMessage(PENDING_TURN_EXTRACTOR_SYSTEM_PROMPT),
        new HumanMessage(
          buildPendingTurnExtractorUserPrompt({
            pendingAction: params.pendingAction,
            actionDescription: params.actionDescription,
            botQuestion: params.botQuestion,
            valueHints: params.valueHints,
            userMessage: trimmed,
          })
        ),
      ],
      { signal: AbortSignal.timeout(1500) }
    );

    if (parsed.status === 'fulfilled' && parsed.value != null) {
      const valueParsed = params.schema.safeParse(parsed.value);
      if (valueParsed.success) {
        return {
          status: 'fulfilled',
          value: valueParsed.data,
          confidence: parsed.confidence,
          reason: parsed.reason,
          source: 'llm',
        };
      }
      return {
        status: 'reprompt',
        value: null,
        confidence: parsed.confidence,
        reason: parsed.reason ?? 'valor_invalido',
        source: 'llm',
      };
    }

    return {
      status: parsed.status,
      value: null,
      confidence: parsed.confidence,
      reason: parsed.reason,
      source: 'llm',
    };
  } catch (error) {
    console.error('[pending-turn] LLM error, fallback reprompt:', error);
    return {
      status: 'reprompt',
      value: null,
      confidence: 0,
      reason: 'llm_error',
      source: 'fallback',
    };
  }
}

/** Formatea el bloque inyectado al contexto del checkout agent. */
export function formatPendingExtractionBlock(params: {
  pendingAction: string;
  botQuestion: string;
  status: PendingTurnStatus;
  confidence: number;
  value: unknown | null;
  reason: string | null;
}): string {
  const lines = [
    '[EXTRACCIÓN PASO PENDIENTE]',
    `- Acción esperada: ${params.pendingAction}`,
    `- Pregunta del bot: "${params.botQuestion.replace(/\n/g, ' ')}"`,
    `- Estado: ${params.status}`,
    `- Confianza: ${params.confidence}`,
  ];
  if (params.status === 'fulfilled' && params.value != null) {
    lines.push(`- Valor extraído: ${JSON.stringify(params.value)}`);
  } else {
    lines.push('- Valor extraído: null');
  }
  if (params.reason) {
    lines.push(`- Motivo: ${params.reason}`);
  }
  return lines.join('\n');
}

/** Type guard helper for payment method extraction in tests. */
export function isPaymentMethodValue(value: unknown): value is PaymentMethodPendingValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    'method' in value &&
    ((value as { method: string }).method === 'cash' ||
      (value as { method: string }).method === 'online')
  );
}
