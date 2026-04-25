import type { MenuCategoryTag } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { findOrCreateConversationState, updateConversationState } from '../repositories';
import type { ConversationMetadata } from './productQuery/types';
import {
  buildMetadataValue,
  getRequestedPartySize,
  normalizeMetadata,
} from './productQuery/utils';

/** Por unidad sin dato de ficha: 1 porción por unidad. */
const SERVES_FALLBACK = 1;

const MEANINGFUL: ReadonlySet<MenuCategoryTag> = new Set([
  'STARTER',
  'MAIN',
  'DRINK',
  'SIDE',
  'DESSERT',
]);

export type CategoryCoverageMap = Partial<Record<MenuCategoryTag, number>>;

export type PortionCoverageResult = {
  coveredPortions: number;
  peopleCount: number | null;
  missingPortions: number | null;
  /** Porciones (qty × serves) en MAIN; redundante con categoryCoverage.MAIN. */
  mainCoveredPortions: number;
  hasMainLine: boolean;
  /** Por categoría: suma de porciones por línea (qty × serves, fallback 1). */
  categoryCoverage: CategoryCoverageMap;
};

type DraftLineForCoverage = {
  quantity: number;
  menu_item: {
    serves_people: number | null;
    menu_category: { category_tag: MenuCategoryTag } | null;
  } | null;
};

export function linePortionCoverage(
  quantity: number,
  servesPeople: number | null | undefined
): number {
  const serves =
    servesPeople != null && servesPeople > 0 ? servesPeople : SERVES_FALLBACK;
  return quantity * serves;
}

function portionForCategory(tag: MenuCategoryTag | undefined | null): tag is MenuCategoryTag {
  return tag != null && MEANINGFUL.has(tag);
}

export function computePortionCoverageFromDraftLines(
  lines: DraftLineForCoverage[]
): Omit<PortionCoverageResult, 'peopleCount' | 'missingPortions'> {
  let coveredPortions = 0;
  const categoryCoverage: CategoryCoverageMap = {};

  for (const line of lines) {
    const mi = line.menu_item;
    if (!mi) continue;
    const cov = linePortionCoverage(line.quantity, mi.serves_people);
    coveredPortions += cov;
    const tag = mi.menu_category?.category_tag;
    if (portionForCategory(tag)) {
      categoryCoverage[tag] = (categoryCoverage[tag] ?? 0) + cov;
    }
  }

  const mainCoveredPortions = categoryCoverage.MAIN ?? 0;
  const hasMainLine = mainCoveredPortions > 0;

  return {
    coveredPortions,
    mainCoveredPortions,
    hasMainLine,
    categoryCoverage,
  };
}

function applyPeopleCount(
  base: Omit<PortionCoverageResult, 'peopleCount' | 'missingPortions'>,
  peopleCount: number | undefined
): PortionCoverageResult {
  const people =
    peopleCount != null && peopleCount > 0 ? peopleCount : null;
  const missingPortions =
    people != null ? Math.max(0, people - base.coveredPortions) : null;
  return {
    ...base,
    peopleCount: people,
    missingPortions,
  };
}

/**
 * Texto extra de porciones/categorías en el mensaje de carrito: desactivado (la UX va por
 * secciones del pedido + total). La cobertura sigue calculándose en
 * {@link syncOrderCoverageToConversationState} para lógica interna / recomendaciones.
 */
export function formatCartGuidanceBlock(_result: PortionCoverageResult): string {
  return '';
}

/**
 * Lee el borrador activo, calcula porciones y persiste `coveredPortions` / `missingPortions` en metadata.
 */
export async function syncOrderCoverageToConversationState(
  conversationId: string,
  businessId: string,
  customerPhone: string
): Promise<PortionCoverageResult> {
  const state = await findOrCreateConversationState(conversationId);
  const meta = normalizeMetadata(state.metadata) as ConversationMetadata;
  const people = getRequestedPartySize(meta);

  const draft = await prisma.draft_order.findFirst({
    where: {
      business_id: businessId,
      customer_phone: customerPhone,
      status: 'active',
    },
    include: {
      draft_order_item: {
        include: {
          menu_item: {
            include: {
              menu_category: { select: { category_tag: true } },
            },
          },
        },
      },
    },
  });

  const empty = !draft?.draft_order_item?.length;
  const base = empty
    ? {
        coveredPortions: 0,
        mainCoveredPortions: 0,
        hasMainLine: false,
        categoryCoverage: {} as CategoryCoverageMap,
      }
    : computePortionCoverageFromDraftLines(draft.draft_order_item);

  const result = applyPeopleCount(base, people);

  const nextMeta: ConversationMetadata = { ...meta };
  nextMeta.coveredPortions = result.coveredPortions;
  if (result.missingPortions != null) {
    nextMeta.missingPortions = result.missingPortions;
  } else {
    delete nextMeta.missingPortions;
  }

  await updateConversationState(conversationId, {
    metadata: buildMetadataValue(nextMeta),
  });

  return result;
}
