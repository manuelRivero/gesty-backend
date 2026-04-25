import { Prisma } from '@prisma/client';
import {
  findOrCreateConversationState,
  updateConversationState,
} from '../repositories/conversationState.repository';
import {
  buildMetadataValue,
  normalizeMetadata,
  partySizeMetadataFields,
  withoutLegacyPartyQuantity,
} from './productQuery/utils';

/**
 * Persiste cantidad de personas/comensales en `conversation_state.metadata`
 * cuando el clasificador (o heurística) aporta un número válido.
 */
export async function persistRequestedPartySizeIfPresent(
  conversationId: string,
  quantity: number | null | undefined
): Promise<void> {
  if (quantity == null || quantity <= 0) return;

  const state = await findOrCreateConversationState(conversationId);
  const prev = withoutLegacyPartyQuantity(normalizeMetadata(state.metadata));

  await updateConversationState(conversationId, {
    metadata: buildMetadataValue({
      ...prev,
      ...partySizeMetadataFields(quantity),
    }),
  } as Prisma.conversation_stateUpdateInput);
}
