import { z } from 'zod';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { getIntentDetectorLlm } from '../../config/llm';
import {
  PENDING_TURN_EXTRACTOR_SYSTEM_PROMPT,
  buildPendingTurnExtractorUserPrompt,
} from '../../prompts/pendingTurnExtractor';
import {
  getCheckoutPendingActionConfig,
  type CheckoutPendingAction,
  type FulfillmentTypePendingValue,
  type PaymentMethodPendingValue,
} from '../checkout/pendingActionRegistry';

export type PendingTurnStatus = 'fulfilled' | 'reprompt' | 'delegate' | 'off_pending';

export type PendingTurnExtractionResult<T> = {
  status: PendingTurnStatus;
  value: T | null;
  confidence: number;
  reason: string | null;
  source: 'deterministic' | 'llm' | 'fallback';
  /** Campo de checkout respondido cuando status === 'off_pending'. */
  resolvedAction?: CheckoutPendingAction;
};

const PendingTurnResponseSchema = z.object({
  status: z.enum(['fulfilled', 'reprompt', 'delegate', 'off_pending']),
  confidence: z.number().min(0).max(1),
  reason: z.string().nullable(),
  value: z.unknown().nullable(),
  resolvedAction: z.enum(['payment_method', 'fulfillment_type', 'confirm_order']).nullable().optional(),
});

const normalizeText = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

function matchFulfillmentType(text: string): FulfillmentTypePendingValue | null {
  const deliveryPatterns = [
    /^(en casa|a domicilio|domicilio|delivery|envio|envío)[.!]?$/,
    /\b(envio|envío)\s+a\s+domicilio\b/,
    /\b(quiero|necesito|mejor|prefiero)\s+.*\b(delivery|domicilio|casa)\b/,
    /\b(mejor|prefiero|quiero)\s+(delivery|domicilio|en casa)\b/,
  ];
  const takeawayPatterns = [
    /^(retiro|take away|takeaway|paso a buscar|retiro en local|retirar en local)[.!]?$/,
    /\b(quiero|voy a|mejor|prefiero)\s+(retirar|buscar)\b/,
    /\b(mejor|prefiero|quiero|voy a)\b.*\b(retiro|retirar|buscar|local|take away|takeaway)\b/,
    /\bretiro\b.*\b(local|buscar)\b/,
  ];

  for (const pattern of deliveryPatterns) {
    if (pattern.test(text)) {
      return { type: 'DELIVERY' };
    }
  }
  for (const pattern of takeawayPatterns) {
    if (pattern.test(text)) {
      return { type: 'TAKE_AWAY' };
    }
  }
  return null;
}

function matchPaymentMethod(text: string): PaymentMethodPendingValue | null {
  const cashPattern =
    /^(efectivo|cash|en efectivo|en mano|pago en efectivo|con efectivo)[.!]?$/;
  const onlinePattern =
    /^(online|tarjeta|mercado pago|mercadopago|pago online|con tarjeta|digital)[.!]?$/;

  if (cashPattern.test(text)) {
    return { method: 'cash' };
  }
  if (onlinePattern.test(text)) {
    return { method: 'online' };
  }
  return null;
}

function tryCrossFieldExtraction<T>(params: {
  pendingAction: string;
  userMessage: string;
}): PendingTurnExtractionResult<T> | null {
  const text = normalizeText(params.userMessage);
  if (!text) return null;

  if (params.pendingAction === 'payment_method') {
    const fulfillment = matchFulfillmentType(text);
    if (fulfillment) {
      return {
        status: 'off_pending',
        value: fulfillment as T,
        resolvedAction: 'fulfillment_type',
        confidence: 0.95,
        reason: fulfillment.type === 'DELIVERY' ? 'delivery_explicito' : 'takeaway_explicito',
        source: 'deterministic',
      };
    }
  }

  if (params.pendingAction === 'fulfillment_type') {
    const payment = matchPaymentMethod(text);
    if (payment) {
      return {
        status: 'off_pending',
        value: payment as T,
        resolvedAction: 'payment_method',
        confidence: 0.95,
        reason: payment.method === 'cash' ? 'efectivo_explicito' : 'online_explicito',
        source: 'deterministic',
      };
    }
  }

  return null;
}

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
    const payment = matchPaymentMethod(text);
    if (payment) {
      const parsed = params.schema.safeParse(payment);
      if (parsed.success) {
        return {
          status: 'fulfilled',
          value: parsed.data,
          confidence: 0.98,
          reason: payment.method === 'cash' ? 'efectivo_explicito' : 'online_explicito',
          source: 'deterministic',
        };
      }
    }

    const crossField = tryCrossFieldExtraction<T>(params);
    if (crossField) return crossField;

    // Nada de regex para "¿esto cambia de tema?" — es una pregunta de
    // significado, no de vocabulario cerrado, y no generaliza a otros
    // idiomas ni formas de preguntar. Eso lo resuelve el clasificador LLM
    // más abajo (su prompt ya instruye "preguntas de precio → delegate").
  }

  if (params.pendingAction === 'fulfillment_type') {
    const fulfillment = matchFulfillmentType(text);
    if (fulfillment) {
      const parsed = params.schema.safeParse(fulfillment);
      if (parsed.success) {
        return {
          status: 'fulfilled',
          value: parsed.data,
          confidence: 0.98,
          reason: fulfillment.type === 'DELIVERY' ? 'delivery_explicito' : 'takeaway_explicito',
          source: 'deterministic',
        };
      }
    }

    const crossField = tryCrossFieldExtraction<T>(params);
    if (crossField) return crossField;

    // Ídem: sin regex de "cambio de tema" — lo resuelve el LLM más abajo.
  }

  // `confirm_order` no tiene atajo determinístico: "sí"/"no" varían demasiado
  // entre idiomas y formas de hablar como para acotarlos a un patrón fijo.
  // El clasificador LLM de abajo ya recibe el schema {confirmed: boolean} y
  // los valueHints de `pendingActionRegistry.ts` — lo resuelve igual que
  // cualquier otro pending action, sin necesitar una rama especial acá.

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
      { signal: AbortSignal.timeout(3000) }
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

    if (parsed.status === 'off_pending' && parsed.resolvedAction && parsed.value != null) {
      if (parsed.resolvedAction !== params.pendingAction) {
        const otherConfig = getCheckoutPendingActionConfig(parsed.resolvedAction);
        if (otherConfig) {
          const valueParsed = otherConfig.schema.safeParse(parsed.value);
          if (valueParsed.success) {
            return {
              status: 'off_pending',
              value: valueParsed.data as T,
              resolvedAction: parsed.resolvedAction,
              confidence: parsed.confidence,
              reason: parsed.reason,
              source: 'llm',
            };
          }
        }
      }
      return {
        status: 'reprompt',
        value: null,
        confidence: parsed.confidence,
        reason: parsed.reason ?? 'off_pending_invalido',
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
  resolvedAction?: CheckoutPendingAction;
}): string {
  const lines = [
    '[EXTRACCIÓN PASO PENDIENTE]',
    `- Acción esperada: ${params.pendingAction}`,
    `- Pregunta del bot: "${params.botQuestion.replace(/\n/g, ' ')}"`,
    `- Estado: ${params.status}`,
    `- Confianza: ${params.confidence}`,
  ];
  if (params.status === 'off_pending' && params.resolvedAction) {
    lines.push(`- Campo respondido: ${params.resolvedAction}`);
  }
  if ((params.status === 'fulfilled' || params.status === 'off_pending') && params.value != null) {
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
