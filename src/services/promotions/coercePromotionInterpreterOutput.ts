/**
 * Normaliza salidas del LLM al envelope V1.
 * gpt-4o-mini en modo json_object a veces aplana `offer` (name/conditions/benefit
 * y daysOfWeek/timeRange en la raíz). Recuperamos ese shape antes de validar.
 */

import {
  PromotionInterpreterLlmSchema,
  type PromotionInterpreterLlmOutput,
} from './promotionInterpreter.schemas';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Intenta convertir la salida cruda del modelo al schema canónico.
 * Devuelve null si no hay forma recuperable.
 */
export function coercePromotionInterpreterOutput(
  raw: unknown
): PromotionInterpreterLlmOutput | null {
  const obj = asRecord(raw);
  if (!obj) return null;

  let candidate: unknown = raw;

  const nestedOffer = asRecord(obj.offer);
  if (nestedOffer) {
    candidate = {
      status: obj.status,
      offer: nestedOffer,
      missingInformation: Array.isArray(obj.missingInformation)
        ? obj.missingInformation
        : [],
      unresolvedEntities: Array.isArray(obj.unresolvedEntities)
        ? obj.unresolvedEntities
        : [],
    };
  } else if (typeof obj.name === 'string' && Array.isArray(obj.conditions)) {
    // Shape aplanado observado en producción:
    // { name, status, conditions, benefit, daysOfWeek, timeRange, unresolvedEntities }
    const existingValidity = asRecord(obj.validity) ?? {};
    const validity: Record<string, unknown> = { ...existingValidity };

    if (Array.isArray(obj.daysOfWeek)) validity.daysOfWeek = obj.daysOfWeek;
    if (asRecord(obj.timeRange)) validity.timeRange = obj.timeRange;
    if (typeof obj.startsAt === 'string') validity.startsAt = obj.startsAt;
    if (typeof obj.endsAt === 'string') validity.endsAt = obj.endsAt;

    const offer: Record<string, unknown> = {
      name: obj.name,
      conditions: obj.conditions,
      benefit: obj.benefit ?? null,
    };
    if (Object.keys(validity).length > 0) {
      offer.validity = validity;
    }
    if (obj.limits !== undefined) offer.limits = obj.limits;
    if (obj.stacking !== undefined) offer.stacking = obj.stacking;

    candidate = {
      status:
        obj.status === 'complete' || obj.status === 'needs_clarification'
          ? obj.status
          : 'needs_clarification',
      offer,
      missingInformation: Array.isArray(obj.missingInformation)
        ? obj.missingInformation
        : [],
      unresolvedEntities: Array.isArray(obj.unresolvedEntities)
        ? obj.unresolvedEntities
        : [],
    };
  } else {
    // Asegurar arrays si vienen omitidos en un envelope casi válido
    if ('offer' in obj || 'status' in obj) {
      candidate = {
        ...obj,
        missingInformation: Array.isArray(obj.missingInformation)
          ? obj.missingInformation
          : [],
        unresolvedEntities: Array.isArray(obj.unresolvedEntities)
          ? obj.unresolvedEntities
          : [],
      };
    }
  }

  const parsed = PromotionInterpreterLlmSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Extrae el JSON crudo del error OUTPUT_PARSING_FAILURE de LangChain:
 * `Failed to parse. Text: "{...}". Error: [...]`
 * También acepta `llmOutput` / `text` si el error es OutputParserException.
 */
export function extractJsonTextFromStructuredOutputError(error: unknown): string | null {
  if (error && typeof error === 'object') {
    const anyErr = error as { llmOutput?: unknown; text?: unknown };
    if (typeof anyErr.llmOutput === 'string' && anyErr.llmOutput.trim()) {
      return anyErr.llmOutput;
    }
    if (typeof anyErr.text === 'string' && anyErr.text.trim()) {
      return anyErr.text;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  const marker = 'Text: "';
  const endMarker = '". Error:';
  const start = message.indexOf(marker);
  if (start < 0) return null;
  const end = message.lastIndexOf(endMarker);
  if (end <= start) return null;

  const embedded = message.slice(start + marker.length, end);
  // Caso 1: el contenido ya es JSON literal (con newlines reales).
  if (embedded.trimStart().startsWith('{')) {
    return embedded;
  }
  // Caso 2: LangChain embebió un string JSON-escaped.
  try {
    return JSON.parse(`"${embedded}"`) as string;
  } catch {
    return embedded;
  }
}

export function tryParseJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
