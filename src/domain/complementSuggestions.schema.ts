import { z } from 'zod';

/** Clave en `conversation_state.metadata`. */
export const COMPLEMENT_METADATA_KEY = 'complementSuggestions' as const;

export const complementSuggestionSnapshotSchema = z.object({
  v: z.literal(1),
  draftOrderId: z.string().uuid(),
  businessId: z.string().uuid(),
  orderedItemIds: z.array(z.string().uuid()),
  pitchBody: z.string(),
  title: z.string(),
  titleEmoji: z.string(),
  createdAtIso: z.string(),
});

export type ComplementSuggestionSnapshot = z.infer<typeof complementSuggestionSnapshotSchema>;

export function parseComplementSnapshot(
  raw: unknown
): ComplementSuggestionSnapshot | null {
  const r = complementSuggestionSnapshotSchema.safeParse(raw);
  return r.success ? r.data : null;
}
