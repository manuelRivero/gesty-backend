import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  getPendingOrderLines,
  validateTaskResolutionOwnership,
} from './pendingOrderLines.service';

export const PRODUCT_RESOLUTIONS_METADATA_KEY = 'productResolutions' as const;
export const PRODUCT_RESOLUTION_TTL_MS = 30 * 60 * 1000;

export type ProductResolutionSource =
  | 'search_products'
  | 'find_products_by_filter'
  | 'whatsapp_presentation'
  | 'last_offer'
  | 'complement';

export type ProductResolutionStatus = 'candidate' | 'resolved' | 'selected' | 'consumed';
export type ProductResolutionScope = 'turn' | 'conversation' | 'pending';

export type ProductResolution = {
  resolutionId: string;
  productId: string;
  businessId: string;
  conversationId: string;
  source: ProductResolutionSource;
  status: ProductResolutionStatus;
  scope: ProductResolutionScope;
  turnId?: string;
  createdAt: string;
  expiresAt: string | null;
  consumedAt?: string;
};

export type ProductResolutionFailure =
  | 'resolution_missing'
  | 'resolution_wrong_business'
  | 'resolution_wrong_conversation'
  | 'resolution_expired'
  | 'resolution_consumed'
  | 'resolution_product_mismatch'
  | 'resolution_not_selected'
  | 'task_not_found'
  | 'task_not_open'
  | 'task_resolution_mismatch'
  | 'resolution_already_owned'
  | 'order_line_id_required';

type MetadataRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is MetadataRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseResolutions = (metadata: unknown): ProductResolution[] => {
  if (!isRecord(metadata)) return [];
  const raw = metadata[PRODUCT_RESOLUTIONS_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is ProductResolution => {
    if (!isRecord(entry)) return false;
    return (
      typeof entry.resolutionId === 'string' &&
      typeof entry.productId === 'string' &&
      typeof entry.businessId === 'string' &&
      typeof entry.conversationId === 'string' &&
      typeof entry.source === 'string' &&
      typeof entry.status === 'string' &&
      typeof entry.scope === 'string' &&
      typeof entry.createdAt === 'string' &&
      (entry.expiresAt === null || typeof entry.expiresAt === 'string')
    );
  });
};

const pendingResolutionForProduct = (
  metadata: unknown,
  productId: string
): string | null => {
  if (!isRecord(metadata)) return null;
  for (const key of ['pendingAddQuantity', 'pendingVariation'] as const) {
    const pending = metadata[key];
    if (
      isRecord(pending) &&
      pending.productId === productId &&
      typeof pending.productResolutionId === 'string'
    ) {
      return pending.productResolutionId;
    }
  }
  return null;
};

const resolutionIdFor = (businessId: string, conversationId: string): string =>
  `pr1:${businessId}:${conversationId}:${randomUUID()}`;

const lockConversationState = async (
  tx: Prisma.TransactionClient,
  conversationId: string
): Promise<unknown> => {
  await tx.conversation_state.upsert({
    where: { conversation_id: conversationId },
    update: {},
    create: { conversation_id: conversationId },
  });
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
  return row?.metadata;
};

const writeResolutionLedger = async (
  tx: Prisma.TransactionClient,
  conversationId: string,
  resolutions: ProductResolution[]
): Promise<void> => {
  await tx.$executeRaw`
    UPDATE conversation_state
    SET metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{productResolutions}',
          ${JSON.stringify(resolutions)}::jsonb,
          true
        ),
        updated_at = NOW()
    WHERE conversation_id = ${conversationId}::uuid
  `;
};

const createResolution = (params: {
  productId: string;
  businessId: string;
  conversationId: string;
  source: ProductResolutionSource;
  status: ProductResolutionStatus;
  scope: ProductResolutionScope;
  turnId?: string;
  expiresAt?: string | null;
}): ProductResolution => ({
  resolutionId: resolutionIdFor(params.businessId, params.conversationId),
  productId: params.productId,
  businessId: params.businessId,
  conversationId: params.conversationId,
  source: params.source,
  status: params.status,
  scope: params.scope,
  ...(params.turnId ? { turnId: params.turnId } : {}),
  createdAt: new Date().toISOString(),
  expiresAt:
    params.expiresAt === undefined
      ? new Date(Date.now() + PRODUCT_RESOLUTION_TTL_MS).toISOString()
      : params.expiresAt,
});

export const issueProductResolutions = async (params: {
  productIds: string[];
  businessId: string;
  conversationId: string;
  source: ProductResolutionSource;
  status: 'candidate' | 'resolved' | 'selected';
  scope: ProductResolutionScope;
  turnId?: string;
  expiresAt?: string | null;
}): Promise<ProductResolution[]> => {
  const uniqueIds = [...new Set(params.productIds.filter((id) => id.trim()))];
  if (uniqueIds.length === 0) return [];

  return prisma.$transaction(async (tx) => {
    const validProducts = await tx.menu_item.findMany({
      where: {
        id: { in: uniqueIds },
        business_id: params.businessId,
        is_available: true,
      },
      select: { id: true },
    });
    const validIds = new Set(validProducts.map((item) => item.id));
    const resolvedIds = uniqueIds.filter((id) => validIds.has(id));
    if (resolvedIds.length === 0) return [];

    const metadata = await lockConversationState(tx, params.conversationId);
    const resolutions = parseResolutions(metadata);
    const added = resolvedIds.map((productId) => createResolution({ ...params, productId }));
    await writeResolutionLedger(tx, params.conversationId, [...resolutions, ...added].slice(-200));
    return added;
  });
};

const parseResolutionContext = (resolutionId: string): {
  businessId: string;
  conversationId: string;
} | null => {
  const parts = resolutionId.split(':');
  if (parts.length !== 4 || parts[0] !== 'pr1') return null;
  return { businessId: parts[1], conversationId: parts[2] };
};

const failureForContext = (params: {
  resolutionId: string;
  businessId: string;
  conversationId: string;
}): ProductResolutionFailure | null => {
  const owner = parseResolutionContext(params.resolutionId);
  if (!owner) return 'resolution_missing';
  if (owner.businessId !== params.businessId) return 'resolution_wrong_business';
  if (owner.conversationId !== params.conversationId) return 'resolution_wrong_conversation';
  return null;
};

const validateResolution = (
  resolution: ProductResolution,
  params: {
    productId: string;
    businessId: string;
    conversationId: string;
    turnId?: string;
    pendingResolutionId?: string | null;
    allowCandidate?: boolean;
  }
): ProductResolutionFailure | null => {
  if (resolution.businessId !== params.businessId) return 'resolution_wrong_business';
  if (resolution.conversationId !== params.conversationId) return 'resolution_wrong_conversation';
  if (resolution.productId !== params.productId) return 'resolution_product_mismatch';
  if (resolution.status === 'consumed') return 'resolution_consumed';
  if (resolution.expiresAt) {
    const expiresAt = Date.parse(resolution.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return 'resolution_expired';
  }
  if (resolution.scope === 'turn' && resolution.turnId !== params.turnId) {
    return 'resolution_expired';
  }
  if (resolution.scope === 'pending' && resolution.resolutionId !== params.pendingResolutionId) {
    return 'resolution_expired';
  }
  if (
    resolution.status === 'candidate' &&
    !params.allowCandidate &&
    resolution.resolutionId !== params.pendingResolutionId
  ) {
    return 'resolution_not_selected';
  }
  return null;
};

export const selectProductResolution = async (params: {
  resolutionId: string;
  productId: string;
  businessId: string;
  conversationId: string;
  turnId?: string;
  explicitButtonSelection?: boolean;
}): Promise<
  { ok: true; resolution: ProductResolution } |
  { ok: false; reason: ProductResolutionFailure }
> => {
  const contextFailure = failureForContext(params);
  if (contextFailure) return { ok: false, reason: contextFailure };

  return prisma.$transaction(async (tx) => {
    const metadata = await lockConversationState(tx, params.conversationId);
    const resolutions = parseResolutions(metadata);
    const index = resolutions.findIndex((item) => item.resolutionId === params.resolutionId);
    if (index < 0) return { ok: false, reason: 'resolution_missing' };
    const current = resolutions[index];
    const failure = validateResolution(current, {
      ...params,
      pendingResolutionId: pendingResolutionForProduct(metadata, current.productId),
      allowCandidate: params.explicitButtonSelection === true,
    });
    if (failure) return { ok: false, reason: failure };
    const selected = { ...current, status: 'selected' as const };
    resolutions[index] = selected;
    await writeResolutionLedger(tx, params.conversationId, resolutions);
    return { ok: true, resolution: selected };
  });
};

export const selectProductResolutionFromButton = async (params: {
  productId: string;
  businessId: string;
  conversationId: string;
}): Promise<
  { ok: true; resolution: ProductResolution } |
  { ok: false; reason: ProductResolutionFailure }
> => {
  const resolutions = await getProductResolutions(params.conversationId);
  const candidate = resolutions
    .filter(
      (item) =>
        item.productId === params.productId &&
        item.businessId === params.businessId &&
        item.conversationId === params.conversationId &&
        item.status === 'candidate' &&
        (!item.expiresAt || Date.parse(item.expiresAt) > Date.now())
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!candidate) return { ok: false, reason: 'resolution_missing' };
  return selectProductResolution({
    ...params,
    resolutionId: candidate.resolutionId,
    explicitButtonSelection: true,
  });
};

export const extendProductResolutionForPending = async (params: {
  resolutionId: string;
  productId: string;
  conversationId: string;
}): Promise<boolean> => {
  const owner = parseResolutionContext(params.resolutionId);
  if (!owner || owner.conversationId !== params.conversationId) return false;
  return prisma.$transaction(async (tx) => {
    const metadata = await lockConversationState(tx, params.conversationId);
    const resolutions = parseResolutions(metadata);
    const index = resolutions.findIndex((item) => item.resolutionId === params.resolutionId);
    if (index < 0) return false;
    const current = resolutions[index];
    if (
      current.productId !== params.productId ||
      current.businessId !== owner.businessId ||
      current.conversationId !== params.conversationId ||
      current.status === 'consumed' ||
      (current.expiresAt != null &&
        (!Number.isFinite(Date.parse(current.expiresAt)) ||
          Date.parse(current.expiresAt) <= Date.now()))
    ) {
      return false;
    }
    if (pendingResolutionForProduct(metadata, params.productId) !== params.resolutionId) {
      return false;
    }
    resolutions[index] = {
      ...current,
      status: 'selected',
      scope: 'pending',
      expiresAt: new Date(Date.now() + PRODUCT_RESOLUTION_TTL_MS).toISOString(),
    };
    await writeResolutionLedger(tx, params.conversationId, resolutions);
    return true;
  });
};

export const getProductResolutions = async (
  conversationId: string
): Promise<ProductResolution[]> => {
  const row = await prisma.conversation_state.findUnique({
    where: { conversation_id: conversationId },
    select: { metadata: true },
  });
  return parseResolutions(row?.metadata);
};

export const resolveProductForAdd = async (params: {
  productId: string;
  businessId: string;
  conversationId: string;
  resolutionId?: string | null;
  turnId?: string;
  pendingResolutionId?: string | null;
}): Promise<
  { ok: true; resolution: ProductResolution } |
  { ok: false; reason: ProductResolutionFailure }
> => {
  let resolutionId = params.resolutionId?.trim() || params.pendingResolutionId?.trim() || '';
  if (!resolutionId) {
    const resolutions = await getProductResolutions(params.conversationId);
    const eligible = resolutions
      .filter(
        (item) =>
          item.productId === params.productId &&
          item.businessId === params.businessId &&
          item.conversationId === params.conversationId &&
          (item.status === 'resolved' || item.status === 'selected') &&
          (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()) &&
          (item.scope !== 'turn' || item.turnId === params.turnId)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    resolutionId = eligible[0]?.resolutionId ?? '';
    if (!resolutionId) {
      const matching = resolutions
        .filter((item) => item.productId === params.productId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (matching?.status === 'consumed') {
        return { ok: false, reason: 'resolution_consumed' };
      }
      if (
        matching?.expiresAt &&
        (!Number.isFinite(Date.parse(matching.expiresAt)) ||
          Date.parse(matching.expiresAt) <= Date.now())
      ) {
        return { ok: false, reason: 'resolution_expired' };
      }
      if (matching?.status === 'candidate') {
        return { ok: false, reason: 'resolution_not_selected' };
      }
      return { ok: false, reason: 'resolution_missing' };
    }
  }

  return selectProductResolution({
    ...params,
    resolutionId,
  });
};

export const consumeProductResolution = async (
  tx: Prisma.TransactionClient,
  params: {
    productId: string;
    businessId: string;
    conversationId: string;
    resolutionId?: string | null;
    turnId?: string;
    pendingResolutionId?: string | null;
    explicitButtonSelection?: boolean;
    orderLineId?: string;
  }
): Promise<
  { ok: true; resolution: ProductResolution } |
  { ok: false; reason: ProductResolutionFailure }
> => {
  const suppliedId = params.resolutionId?.trim() ?? '';
  const contextFailure = suppliedId
    ? failureForContext({ ...params, resolutionId: suppliedId })
    : null;
  if (contextFailure) return { ok: false, reason: contextFailure };

  const metadata = await lockConversationState(tx, params.conversationId);
  if (params.orderLineId) {
    const ownership = validateTaskResolutionOwnership({
      metadata,
      taskId: params.orderLineId,
      resolutionId: suppliedId,
    });
    if (!ownership.ok) return { ok: false, reason: ownership.reason };
  } else if (getPendingOrderLines(metadata)?.lines.some(
    (line) => line.status === 'active' || line.status === 'queued'
  )) {
    return { ok: false, reason: 'order_line_id_required' };
  }
  const resolutions = parseResolutions(metadata);
  const eligibleStatuses: ProductResolutionStatus[] = params.explicitButtonSelection
    ? ['candidate', 'resolved', 'selected']
    : ['resolved', 'selected'];
  const matches = resolutions.filter((item) =>
    suppliedId
      ? item.resolutionId === suppliedId
      : item.productId === params.productId &&
        (eligibleStatuses.includes(item.status) || item.status === 'consumed')
  );
  const resolution = matches
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!resolution) {
    const anyMatchingProduct = resolutions
      .filter((item) => item.productId === params.productId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (anyMatchingProduct?.status === 'consumed') {
      return { ok: false, reason: 'resolution_consumed' };
    }
    if (anyMatchingProduct?.status === 'candidate') {
      return { ok: false, reason: 'resolution_not_selected' };
    }
    return { ok: false, reason: 'resolution_missing' };
  }

  const failure = validateResolution(resolution, {
    ...params,
    pendingResolutionId: pendingResolutionForProduct(metadata, resolution.productId),
    allowCandidate: params.explicitButtonSelection === true,
  });
  if (failure) return { ok: false, reason: failure };

  const consumed: ProductResolution = {
    ...resolution,
    status: 'consumed',
    consumedAt: new Date().toISOString(),
  };
  const index = resolutions.findIndex((item) => item.resolutionId === resolution.resolutionId);
  resolutions[index] = consumed;
  await writeResolutionLedger(tx, params.conversationId, resolutions);
  return { ok: true, resolution: consumed };
};

export const productResolutionErrorMessage = (reason: ProductResolutionFailure): string => {
  switch (reason) {
    case 'resolution_wrong_business':
    case 'resolution_wrong_conversation':
      return 'La selección del producto ya no es válida para este pedido. Volvé a elegirlo desde el menú.';
    case 'resolution_expired':
      return 'La selección del producto venció. Volvé a elegirlo desde el menú.';
    case 'resolution_consumed':
      return 'Esa selección ya se usó. Volvé a elegir el producto si todavía querés agregarlo.';
    case 'resolution_product_mismatch':
    case 'resolution_not_selected':
      return 'Ese producto todavía no fue seleccionado. Resolvé la selección antes de agregarlo.';
    case 'task_not_found':
    case 'task_not_open':
    case 'task_resolution_mismatch':
    case 'resolution_already_owned':
      return 'La selección no pertenece a esta línea del pedido. Volvé a resolver el producto para esa línea.';
    case 'order_line_id_required':
      return 'Indicá la línea exacta del pedido antes de agregar el producto.';
    case 'resolution_missing':
      return 'No hay una selección válida de ese producto. Buscalo o elegilo desde el menú antes de agregarlo.';
  }
};