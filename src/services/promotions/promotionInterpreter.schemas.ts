/**
 * Schemas Zod del structured output del PromotionInterpreter (V1).
 * El LLM debe devolver exactamente esta forma; el backend re-valida con safeParse.
 */

import { z } from 'zod';

const ConditionOperatorSchema = z.enum([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'contains',
]);

export const ConditionSchema = z.object({
  field: z.string().min(1),
  operator: ConditionOperatorSchema,
  value: z.unknown(),
});

export const BenefitSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('percentage_discount'),
    value: z.number().positive().max(100),
  }),
  z.object({
    type: z.literal('fixed_discount'),
    value: z.number().positive(),
  }),
  z.object({
    type: z.literal('fixed_price'),
    value: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal('free_product'),
    productName: z.string().min(1),
    quantity: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('free_shipping'),
  }),
]);

const TimeHhMmSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:mm');

export const OfferValiditySchema = z
  .object({
    startsAt: z.string().min(1).optional(),
    endsAt: z.string().min(1).optional(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
    timeRange: z
      .object({
        from: TimeHhMmSchema,
        to: TimeHhMmSchema,
      })
      .optional(),
  })
  .optional();

export const StructuredOfferSchema = z.object({
  name: z.string().min(1),
  conditions: z.array(ConditionSchema),
  benefit: BenefitSchema.nullable().optional(),
  validity: OfferValiditySchema,
  limits: z
    .object({
      maxUsesTotal: z.number().int().positive().optional(),
      maxUsesPerCustomer: z.number().int().positive().optional(),
    })
    .optional(),
  stacking: z
    .object({
      allowed: z.boolean(),
    })
    .optional(),
});

export const MissingInformationSchema = z.object({
  field: z.string().min(1),
  question: z.string().min(1),
});

export const UnresolvedEntitySchema = z.object({
  type: z.enum(['product', 'category', 'other']),
  text: z.string().min(1),
  path: z.string().min(1),
});

/** Schema que el LLM debe producir vía withStructuredOutput. */
export const PromotionInterpreterLlmSchema = z.object({
  status: z.enum(['complete', 'needs_clarification']),
  offer: StructuredOfferSchema,
  missingInformation: z.array(MissingInformationSchema),
  unresolvedEntities: z.array(UnresolvedEntitySchema),
});

export type PromotionInterpreterLlmOutput = z.infer<typeof PromotionInterpreterLlmSchema>;
