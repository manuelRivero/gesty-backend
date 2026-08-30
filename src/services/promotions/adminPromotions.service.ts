/**
 * CRUD de promociones para el panel admin
 * (PLAN-ACCION-PROMOCIONES-PERSISTENCIA.md, fases 3–5).
 *
 * `offer` es la fuente de verdad (D1); las columnas escalares son cache
 * derivada que se recalcula en cada escritura — nunca se editan a mano.
 * Todo filtra por `business_id` del token (D10). Nada de esto aplica descuentos
 * todavía: no hay motor.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { StructuredOfferSchema } from './promotionInterpreter.schemas';
import {
  assertPromotionActivatable,
  assertPromotionComplete,
  assertTransition,
  STATUS_LABELS,
} from './promotionStatus';
import { buildPromotionDisplay, buildSummaryLine } from './buildPromotionDisplay';
import type {
  PromotionDto,
  PromotionProductLink,
  PromotionStatus,
  StructuredOffer,
  UnresolvedEntity,
} from './promotionOffer.types';

export const PROMOTION_PAGE_SIZE_DEFAULT = 20;
export const PROMOTION_PAGE_SIZE_MAX = 100;

export class PromotionNotFoundError extends Error {
  readonly code = 'PROMOTION_NOT_FOUND';
  constructor() {
    super('Promoción no encontrada');
    this.name = 'PromotionNotFoundError';
  }
}

export class PromotionForeignProductError extends Error {
  readonly code = 'PROMOTION_PRODUCT_FOREIGN';
  constructor(readonly menuItemIds: string[]) {
    super('Algún platillo no pertenece a este negocio');
    this.name = 'PromotionForeignProductError';
  }
}

export class PromotionInvalidOfferError extends Error {
  readonly code = 'PROMOTION_INVALID_OFFER';
  constructor(readonly details: unknown) {
    super('La oferta no pasó la validación');
    this.name = 'PromotionInvalidOfferError';
  }
}

type PromotionRow = Prisma.promotionGetPayload<{
  include: {
    products: {
      include: { menu_item: { select: { id: true; name: true; image: true } } };
    };
  };
}>;

const promotionInclude = {
  products: {
    include: { menu_item: { select: { id: true, name: true, image: true } } },
    orderBy: { created_at: 'asc' as const },
  },
} satisfies Prisma.promotionInclude;

function parseOffer(raw: unknown): StructuredOffer {
  const parsed = StructuredOfferSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PromotionInvalidOfferError(parsed.error.flatten());
  }
  return parsed.data as StructuredOffer;
}

/** Columnas escalares derivadas de `offer` para filtrar sin abrir el JSON (D1). */
function deriveScalars(offer: StructuredOffer) {
  const validity = offer.validity;
  return {
    benefit_type: offer.benefit?.type ?? null,
    starts_at: validity?.startsAt ? toDateOrNull(validity.startsAt) : null,
    ends_at: validity?.endsAt ? toDateOrNull(validity.endsAt) : null,
    days_of_week: validity?.daysOfWeek ?? [],
    time_from: validity?.timeRange?.from ?? null,
    time_to: validity?.timeRange?.to ?? null,
  };
}

function toDateOrNull(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Entidades derivadas del offer persistido, para poder reconstruir el `display`
 * con los mismos cards que devuelve el intérprete.
 */
function entitiesFromRow(row: PromotionRow, offer: StructuredOffer): UnresolvedEntity[] {
  const entities: UnresolvedEntity[] = [];
  for (const link of row.products) {
    entities.push({ type: 'product', text: link.source_text, path: link.offer_path });
  }
  if (entities.length > 0) return entities;

  // Promoción sin productos (ej. envío gratis por monto)
  return offer.conditions.flatMap(() => []);
}

export function mapPromotionRow(row: PromotionRow): PromotionDto {
  const offer = parseOffer(row.offer);
  const status = row.status as PromotionStatus;

  const resolutions = row.products.map((link) => ({
    path: link.offer_path,
    resolved: true,
    candidates: [
      {
        menuItemId: link.menu_item.id,
        name: link.menu_item.name,
        thumbnailUrl: link.menu_item.image ?? null,
        price: null,
        currencyCode: null,
        score: 1,
        source: 'exact' as const,
        matchedVariation: null,
      },
    ],
  }));

  return {
    id: row.id,
    name: row.name,
    status,
    statusLabel: STATUS_LABELS[status] ?? row.status,
    offer,
    products: row.products.map((link) => ({
      menuItemId: link.menu_item.id,
      name: link.menu_item.name,
      thumbnailUrl: link.menu_item.image ?? null,
      role: link.role as 'condition' | 'benefit',
      offerPath: link.offer_path,
      sourceText: link.source_text,
      quantity: link.quantity ?? null,
    })),
    sourceType: (row.source_type as 'text' | 'audio') ?? 'text',
    sourceText: row.source_text ?? null,
    summaryLine: buildSummaryLine(offer),
    display: buildPromotionDisplay({
      status: 'complete',
      offer,
      unresolvedEntities: entitiesFromRow(row, offer),
      resolutions,
    }),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** D10: ningún `menuItemId` del body puede ser de otro negocio. */
async function assertProductsBelongToBusiness(params: {
  businessId: string;
  productLinks: PromotionProductLink[];
}): Promise<void> {
  const ids = [...new Set(params.productLinks.map((link) => link.menuItemId))];
  if (ids.length === 0) return;

  const found = await prisma.menu_item.findMany({
    where: { id: { in: ids }, business_id: params.businessId },
    select: { id: true },
  });

  const foundIds = new Set(found.map((item) => item.id));
  const foreign = ids.filter((id) => !foundIds.has(id));
  if (foreign.length > 0) {
    throw new PromotionForeignProductError(foreign);
  }
}

export async function createPromotion(params: {
  businessId: string;
  userId?: string | null;
  offer: unknown;
  productLinks: PromotionProductLink[];
  status?: PromotionStatus;
  sourceType?: 'text' | 'audio';
  sourceText?: string | null;
  name?: string;
}): Promise<PromotionDto> {
  const offer = parseOffer(params.offer);
  const productLinks = params.productLinks ?? [];

  const status = params.status ?? 'draft';

  // Guardar borrador: solo completitud. Activar: además evaluable (D1/D2/B7).
  if (status === 'active') {
    assertPromotionActivatable({ offer, productLinks });
  } else {
    assertPromotionComplete({ offer, productLinks });
  }
  await assertProductsBelongToBusiness({
    businessId: params.businessId,
    productLinks,
  });

  if (status !== 'draft') {
    assertTransition('draft', status);
  }

  const created = await prisma.$transaction(async (tx) => {
    const promotion = await tx.promotion.create({
      data: {
        business_id: params.businessId,
        name: (params.name ?? offer.name).trim(),
        status,
        offer: offer as unknown as Prisma.InputJsonValue,
        ...deriveScalars(offer),
        source_type: params.sourceType ?? 'text',
        source_text: params.sourceText ?? null,
        created_by: params.userId ?? null,
      },
    });

    if (productLinks.length > 0) {
      await tx.promotion_product.createMany({
        data: productLinks.map((link) => ({
          promotion_id: promotion.id,
          menu_item_id: link.menuItemId,
          role: link.role,
          offer_path: link.path,
          source_text: link.sourceText,
          quantity: link.quantity ?? null,
        })),
        skipDuplicates: true,
      });
    }

    return tx.promotion.findUniqueOrThrow({
      where: { id: promotion.id },
      include: promotionInclude,
    });
  });

  console.log(
    JSON.stringify({
      event: '[admin-promotions] created',
      businessId: params.businessId,
      promotionId: created.id,
      status: created.status,
      benefitType: created.benefit_type,
      productLinks: productLinks.length,
      sourceType: created.source_type,
    })
  );

  return mapPromotionRow(created);
}

export type ListPromotionsResult = {
  items: PromotionDto[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export async function listPromotions(params: {
  businessId: string;
  page?: number;
  pageSize?: number;
  status?: PromotionStatus;
  q?: string;
  includeArchived?: boolean;
}): Promise<ListPromotionsResult> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(
    PROMOTION_PAGE_SIZE_MAX,
    Math.max(1, params.pageSize ?? PROMOTION_PAGE_SIZE_DEFAULT)
  );

  const where: Prisma.promotionWhereInput = {
    business_id: params.businessId,
  };

  if (params.status) {
    where.status = params.status;
  } else if (!params.includeArchived) {
    where.status = { not: 'archived' };
  }

  if (params.q?.trim()) {
    where.name = { contains: params.q.trim(), mode: 'insensitive' };
  }

  const [rows, total] = await Promise.all([
    prisma.promotion.findMany({
      where,
      include: promotionInclude,
      orderBy: { created_at: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.promotion.count({ where }),
  ]);

  return {
    items: rows.map(mapPromotionRow),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getPromotionById(params: {
  businessId: string;
  id: string;
}): Promise<PromotionDto> {
  const row = await prisma.promotion.findFirst({
    where: { id: params.id, business_id: params.businessId },
    include: promotionInclude,
  });
  if (!row) throw new PromotionNotFoundError();
  return mapPromotionRow(row);
}

export async function updatePromotion(params: {
  businessId: string;
  id: string;
  name?: string;
  offer?: unknown;
  productLinks?: PromotionProductLink[];
  status?: PromotionStatus;
}): Promise<PromotionDto> {
  const existing = await prisma.promotion.findFirst({
    where: { id: params.id, business_id: params.businessId },
    include: promotionInclude,
  });
  if (!existing) throw new PromotionNotFoundError();

  const currentStatus = existing.status as PromotionStatus;
  const nextStatus = params.status ?? currentStatus;
  assertTransition(currentStatus, nextStatus);

  const offer =
    params.offer !== undefined ? parseOffer(params.offer) : parseOffer(existing.offer);

  // Los links se reemplazan por completo; no hacemos merge parcial.
  const productLinks =
    params.productLinks ??
    existing.products.map((link) => ({
      path: link.offer_path,
      role: link.role as 'condition' | 'benefit',
      menuItemId: link.menu_item_id,
      sourceText: link.source_text,
      quantity: link.quantity ?? null,
    }));

  // Idem create: el gate duro solo corre cuando el estado destino es `active`.
  // Una promo ya activa que se edita vuelve a pasar por el gate (el offer pudo
  // cambiar a una forma no evaluable).
  if (nextStatus === 'active') {
    assertPromotionActivatable({ offer, productLinks });
  } else {
    assertPromotionComplete({ offer, productLinks });
  }
  await assertProductsBelongToBusiness({ businessId: params.businessId, productLinks });

  const updated = await prisma.$transaction(async (tx) => {
    await tx.promotion.update({
      where: { id: existing.id },
      data: {
        name: (params.name ?? offer.name).trim(),
        status: nextStatus,
        offer: offer as unknown as Prisma.InputJsonValue,
        ...deriveScalars(offer),
      },
    });

    if (params.productLinks !== undefined || params.offer !== undefined) {
      await tx.promotion_product.deleteMany({ where: { promotion_id: existing.id } });
      if (productLinks.length > 0) {
        await tx.promotion_product.createMany({
          data: productLinks.map((link) => ({
            promotion_id: existing.id,
            menu_item_id: link.menuItemId,
            role: link.role,
            offer_path: link.path,
            source_text: link.sourceText,
            quantity: link.quantity ?? null,
          })),
          skipDuplicates: true,
        });
      }
    }

    return tx.promotion.findUniqueOrThrow({
      where: { id: existing.id },
      include: promotionInclude,
    });
  });

  console.log(
    JSON.stringify({
      event: '[admin-promotions] updated',
      businessId: params.businessId,
      promotionId: updated.id,
      from: currentStatus,
      to: nextStatus,
    })
  );

  return mapPromotionRow(updated);
}

/** D5: borrar es archivar. No hay delete físico. */
export async function archivePromotion(params: {
  businessId: string;
  id: string;
}): Promise<void> {
  const existing = await prisma.promotion.findFirst({
    where: { id: params.id, business_id: params.businessId },
    select: { id: true, status: true },
  });
  if (!existing) throw new PromotionNotFoundError();

  assertTransition(existing.status as PromotionStatus, 'archived');

  await prisma.promotion.update({
    where: { id: existing.id },
    data: { status: 'archived' },
  });

  console.log(
    JSON.stringify({
      event: '[admin-promotions] archived',
      businessId: params.businessId,
      promotionId: existing.id,
    })
  );
}
