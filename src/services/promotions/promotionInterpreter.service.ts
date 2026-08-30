/**
 * Interpreta lenguaje natural → StructuredOffer V1.
 * LLM interpreta (JSON); backend coerce + valida y enriquece unresolvedEntities.
 * No persiste promociones.
 */

import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { getIntentDetectorLlm } from '../../config/llm';
import {
  PROMOTION_INTERPRETER_SYSTEM_PROMPT,
  buildPromotionInterpreterUserPrompt,
} from '../../prompts/promotionInterpreter';
import {
  coercePromotionInterpreterOutput,
  extractJsonTextFromStructuredOutputError,
  tryParseJsonObject,
} from './coercePromotionInterpreterOutput';
import {
  PromotionInterpreterLlmSchema,
  type PromotionInterpreterLlmOutput,
} from './promotionInterpreter.schemas';
import type {
  PromotionInterpretOutcome,
  StructuredOffer,
  UnresolvedEntity,
} from './promotionOffer.types';
import { buildPromotionDisplay, type EntityResolution } from './buildPromotionDisplay';
import {
  collectConditionProblems,
  describeBenefitProblems,
} from './promotionConditions';
import { resolveProductEntities } from './resolveProductEntities';

function collectUnresolvedFromOffer(offer: StructuredOffer): UnresolvedEntity[] {
  const entities: UnresolvedEntity[] = [];

  offer.conditions.forEach((condition, index) => {
    const value = condition.value;
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as { productName?: unknown }).productName === 'string'
    ) {
      const productName = (value as { productName: string }).productName.trim();
      if (productName) {
        entities.push({
          type: 'product',
          text: productName,
          path: `offer.conditions[${index}].value.productName`,
        });
      }
    }
  });

  // `nth_free` (2x1) nombra su producto en el mismo path que `free_product`.
  if (
    (offer.benefit?.type === 'free_product' || offer.benefit?.type === 'nth_free') &&
    offer.benefit.productName.trim()
  ) {
    entities.push({
      type: 'product',
      text: offer.benefit.productName.trim(),
      path: 'offer.benefit.productName',
    });
  }

  // Descuento monetario apuntado a un platillo: también hay que vincularlo.
  if (offer.benefit && 'target' in offer.benefit && offer.benefit.target) {
    const target = offer.benefit.target;
    if (target.scope === 'product' && target.productName.trim()) {
      entities.push({
        type: 'product',
        text: target.productName.trim(),
        path: 'offer.benefit.target.productName',
      });
    }
  }

  return entities;
}

function mergeUnresolved(
  fromLlm: UnresolvedEntity[],
  derived: UnresolvedEntity[]
): UnresolvedEntity[] {
  const seen = new Set<string>();
  const out: UnresolvedEntity[] = [];
  for (const entity of [...fromLlm, ...derived]) {
    const key = `${entity.type}|${entity.text.toLowerCase()}|${entity.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entity);
  }
  return out;
}

function normalizeStatus(
  parsed: PromotionInterpreterLlmOutput
): 'complete' | 'needs_clarification' {
  const missing = parsed.missingInformation ?? [];
  if (missing.length > 0) return 'needs_clarification';
  if (!parsed.offer.benefit) return 'needs_clarification';
  return parsed.status === 'complete' ? 'complete' : 'needs_clarification';
}

/**
 * Una interpretación que el motor no podría evaluar no puede salir como
 * `complete` (D1/D2): el panel habilitaría "Guardar y activar" y el gate de
 * `promotionStatus` la rechazaría después, o peor, quedaría activa y no se
 * aplicaría nunca. Se degrada acá, con la pregunta que el admin tiene que
 * responder.
 */
function collectEvaluabilityMissing(
  offer: PromotionInterpreterLlmOutput['offer']
): PromotionInterpreterLlmOutput['missingInformation'] {
  const problems = [
    ...collectConditionProblems(offer),
    ...(offer.benefit ? describeBenefitProblems(offer.benefit) : []),
  ];
  return problems.map((problem, index) => ({
    field: `offer.evaluability[${index}]`,
    question: problem,
  }));
}

function ensureBenefitMissing(
  parsed: PromotionInterpreterLlmOutput
): PromotionInterpreterLlmOutput['missingInformation'] {
  const missing = [...(parsed.missingInformation ?? [])];
  if (!parsed.offer.benefit && !missing.some((m) => m.field === 'benefit')) {
    missing.push({
      field: 'benefit',
      question: '¿Qué beneficio quieres ofrecer?',
    });
  }
  for (const entry of collectEvaluabilityMissing(parsed.offer)) {
    if (!missing.some((m) => m.question === entry.question)) {
      missing.push(entry);
    }
  }
  return missing;
}

function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .join('');
  }
  return String(content ?? '');
}

async function finalizeInterpretation(
  validated: PromotionInterpreterLlmOutput,
  meta: {
    businessId?: string;
    normalizedText: string;
    startedAt: number;
    recovered: boolean;
    resolveProducts: boolean;
  }
): Promise<PromotionInterpretOutcome> {
  const missingInformation = ensureBenefitMissing(validated);
  const status = normalizeStatus({ ...validated, missingInformation });
  const unresolvedEntities = mergeUnresolved(
    validated.unresolvedEntities ?? [],
    collectUnresolvedFromOffer(validated.offer)
  );

  let resolutions: EntityResolution[] = [];
  if (meta.resolveProducts && meta.businessId && unresolvedEntities.length > 0) {
    const resolved = await resolveProductEntities({
      businessId: meta.businessId,
      entities: unresolvedEntities,
    });
    resolutions = resolved.map((item) => ({
      path: item.entity.path,
      candidates: item.candidates,
      resolved: item.resolved,
    }));
  }

  const result = {
    status,
    offer: validated.offer,
    missingInformation,
    unresolvedEntities,
    display: buildPromotionDisplay({
      status,
      offer: validated.offer,
      unresolvedEntities,
      resolutions,
    }),
  };

  console.log(
    JSON.stringify({
      event: '[promotion-interpreter] ok',
      businessId: meta.businessId ?? null,
      inputType: 'text',
      normalizedText: meta.normalizedText,
      status: result.status,
      missingCount: result.missingInformation.length,
      unresolvedCount: result.unresolvedEntities.length,
      offerName: result.offer.name,
      benefitType: result.offer.benefit?.type ?? null,
      recoveredFromFlatShape: meta.recovered,
      latencyMs: Date.now() - meta.startedAt,
      structuredOutput: result,
      validationResult: 'ok',
    })
  );

  return result;
}

export async function interpretPromotionText(params: {
  text: string;
  businessId?: string;
  /** Buscar candidatos del menú en el mismo turno (D8). Default true. */
  resolveProducts?: boolean;
}): Promise<PromotionInterpretOutcome> {
  const startedAt = Date.now();
  const normalizedText = params.text.trim();
  const resolveProducts = params.resolveProducts ?? true;

  if (!normalizedText) {
    console.log(
      JSON.stringify({
        event: '[promotion-interpreter] empty_input',
        businessId: params.businessId ?? null,
        latencyMs: Date.now() - startedAt,
      })
    );
    return {
      status: 'error',
      code: 'EMPTY_INPUT',
      message: 'El texto a interpretar está vacío',
    };
  }

  let rawLlm: unknown;
  let recovered = false;

  try {
    // Preferimos structured output; si el modelo aplana el JSON, recuperamos abajo.
    const llm = getIntentDetectorLlm().withStructuredOutput(PromotionInterpreterLlmSchema);
    rawLlm = await llm.invoke([
      new SystemMessage(PROMOTION_INTERPRETER_SYSTEM_PROMPT),
      new HumanMessage(buildPromotionInterpreterUserPrompt(normalizedText)),
    ]);
  } catch (error) {
    const embedded = extractJsonTextFromStructuredOutputError(error);
    const parsedEmbedded = embedded ? tryParseJsonObject(embedded) : null;
    const coercedFromError = parsedEmbedded
      ? coercePromotionInterpreterOutput(parsedEmbedded)
      : null;

    if (coercedFromError) {
      recovered = true;
      console.log(
        JSON.stringify({
          event: '[promotion-interpreter] recovered_flat_shape',
          businessId: params.businessId ?? null,
          latencyMs: Date.now() - startedAt,
        })
      );
      return finalizeInterpretation(coercedFromError, {
        businessId: params.businessId,
        normalizedText,
        startedAt,
        recovered,
        resolveProducts,
      });
    }

    // Fallback: un invoke JSON libre + coerce (mismo modelo).
    try {
      const fallback = await getIntentDetectorLlm().invoke([
        new SystemMessage(PROMOTION_INTERPRETER_SYSTEM_PROMPT),
        new HumanMessage(buildPromotionInterpreterUserPrompt(normalizedText)),
      ]);
      const text = messageContentToText(fallback.content);
      const parsed = tryParseJsonObject(text);
      const coerced = parsed ? coercePromotionInterpreterOutput(parsed) : null;
      if (coerced) {
        recovered = true;
        console.log(
          JSON.stringify({
            event: '[promotion-interpreter] recovered_via_json_fallback',
            businessId: params.businessId ?? null,
            latencyMs: Date.now() - startedAt,
          })
        );
        return finalizeInterpretation(coerced, {
          businessId: params.businessId,
          normalizedText,
          startedAt,
          recovered,
          resolveProducts,
        });
      }
    } catch (fallbackError) {
      console.error(
        JSON.stringify({
          event: '[promotion-interpreter] fallback_failed',
          businessId: params.businessId ?? null,
          error: String(fallbackError),
        })
      );
    }

    console.error(
      JSON.stringify({
        event: '[promotion-interpreter] llm_failed',
        businessId: params.businessId ?? null,
        error: String(error),
        latencyMs: Date.now() - startedAt,
      })
    );
    return {
      status: 'error',
      code: 'LLM_FAILED',
      message: 'No se pudo interpretar la promoción',
    };
  }

  const coerced = coercePromotionInterpreterOutput(rawLlm);
  if (!coerced) {
    console.error(
      JSON.stringify({
        event: '[promotion-interpreter] validation_failed',
        businessId: params.businessId ?? null,
        rawPreview: JSON.stringify(rawLlm).slice(0, 800),
        latencyMs: Date.now() - startedAt,
      })
    );
    return {
      status: 'error',
      code: 'VALIDATION_FAILED',
      message: 'La interpretación no pasó la validación',
    };
  }

  // Si vino aplanado pero withStructuredOutput no falló (poco probable), marcar recovered
  const direct = PromotionInterpreterLlmSchema.safeParse(rawLlm);
  recovered = !direct.success;

  return finalizeInterpretation(coerced, {
    businessId: params.businessId,
    normalizedText,
    startedAt,
    recovered,
    resolveProducts,
  });
}

/** Expone el schema para tests de forma de casos. */
export { PromotionInterpreterLlmSchema };
