// repositories/conversationState.repository.ts
import { Prisma, type conversation_state } from '@prisma/client';
import { prisma } from '../lib/prisma';

const PRODUCT_RESOLUTIONS_KEY = 'productResolutions';

const asMetadataRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};

const preserveConsumedProductResolutions = (
  incoming: unknown,
  current: unknown
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput => {
  const currentMetadata = asMetadataRecord(current);
  const consumed = Array.isArray(currentMetadata[PRODUCT_RESOLUTIONS_KEY])
    ? (currentMetadata[PRODUCT_RESOLUTIONS_KEY] as Array<Record<string, unknown>>).filter(
        (entry) => entry && entry.status === 'consumed' && typeof entry.resolutionId === 'string'
      )
    : [];
  const nextMetadata = asMetadataRecord(incoming);
  if (consumed.length === 0 && incoming === Prisma.JsonNull) return Prisma.JsonNull;

  const incomingResolutions = Array.isArray(nextMetadata[PRODUCT_RESOLUTIONS_KEY])
    ? (nextMetadata[PRODUCT_RESOLUTIONS_KEY] as Array<Record<string, unknown>>)
    : [];
  const consumedById = new Map(consumed.map((entry) => [entry.resolutionId as string, entry]));
  const merged = incomingResolutions.map((entry) => {
    if (typeof entry?.resolutionId !== 'string') return entry;
    return consumedById.get(entry.resolutionId) ?? entry;
  });
  const present = new Set(
    merged.flatMap((entry) =>
      typeof entry?.resolutionId === 'string' ? [entry.resolutionId] : []
    )
  );
  merged.push(...consumed.filter((entry) => !present.has(entry.resolutionId as string)));
  nextMetadata[PRODUCT_RESOLUTIONS_KEY] = merged.slice(-200);
  return nextMetadata as Prisma.InputJsonValue;
};

export const findOrCreateConversationState = async (
  conversationId: string
): Promise<conversation_state> => {
  return prisma.conversation_state.upsert({
    where: { conversation_id: conversationId },
    update: {},
    create: { conversation_id: conversationId }
  });
};

export const updateConversationState = async (
  conversationId: string,
  data: Prisma.conversation_stateUpdateInput
): Promise<conversation_state> => {
  if (data.metadata === undefined) {
    return prisma.conversation_state.update({
      where: { conversation_id: conversationId },
      data,
    });
  }

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT conversation_id
      FROM conversation_state
      WHERE conversation_id = ${conversationId}::uuid
      FOR UPDATE
    `;
    const current = await tx.conversation_state.findUnique({
      where: { conversation_id: conversationId },
      select: { metadata: true },
    });
    return tx.conversation_state.update({
      where: { conversation_id: conversationId },
      data: {
        ...data,
        metadata: preserveConsumedProductResolutions(data.metadata, current?.metadata),
      },
    });
  });
};

/** Fusiona `patch` en `metadata` existente sin pisar otras claves (reservas, onboarding, etc.). */
export const patchConversationMetadata = async (
  conversationId: string,
  patch: Record<string, unknown>
): Promise<conversation_state> => {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT conversation_id
      FROM conversation_state
      WHERE conversation_id = ${conversationId}::uuid
      FOR UPDATE
    `;
    const row = await tx.conversation_state.findUnique({
      where: { conversation_id: conversationId },
      select: { metadata: true },
    });
    const next = { ...asMetadataRecord(row?.metadata), ...patch };
    const metadata = preserveConsumedProductResolutions(next, row?.metadata);
    return tx.conversation_state.update({
      where: { conversation_id: conversationId },
      data: { metadata },
    });
  });
};

export const omitConversationMetadataKeys = async (
  conversationId: string,
  keys: string[]
): Promise<conversation_state> => {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT conversation_id
      FROM conversation_state
      WHERE conversation_id = ${conversationId}::uuid
      FOR UPDATE
    `;
    const row = await tx.conversation_state.findUnique({
      where: { conversation_id: conversationId },
      select: { metadata: true },
    });
    const next = asMetadataRecord(row?.metadata);
    for (const key of keys) delete next[key];
    const metadata = preserveConsumedProductResolutions(next, row?.metadata);
    return tx.conversation_state.update({
      where: { conversation_id: conversationId },
      data: { metadata },
    });
  });
};


export const upsertConversationState = async (
  conversationId: string,
  data: Prisma.conversation_stateCreateInput
) => {
  return prisma.conversation_state.upsert({
    where: { conversation_id: conversationId },
    update: data,
    create: data,
  });
};