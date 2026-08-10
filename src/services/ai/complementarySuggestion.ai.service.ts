import type { MenuCategoryTag } from '@prisma/client';
import type { business as Business } from '@prisma/client';
import type { ComplementSuggestionSnapshot } from '../../domain/complementSuggestions.schema';
import {
  type BuildComplementarySuggestionsParams,
  type ComplementaryMenuItemSummary,
  collectCategoryTagsInDraftCart,
  fetchComplementaryMenuItems,
  getMenuItemCategoryTag,
  getMissingMenuCompleteTags,
  pickFallbackNextTags,
} from '../../helpers/complementaryMenu.helper';
import { prisma } from '../../lib/prisma';
import { generateAIResponse } from './openai.service';
import { resolvePersonalityForBusiness } from '../botPersonality.service';
import { buildComplementarySuggestionSystemPrompt } from '../../prompts/botPersonality';
import { normalizeWhatsAppBoldMarkers, wrapWhatsAppBold } from '../../utils/whatsappBold';

const TAG_LABELS: Record<MenuCategoryTag, { title: string; emoji: string }> = {
  STARTER: { title: 'Podés sumar una entrada', emoji: '🥗' },
  MAIN: { title: 'Plato principal', emoji: '🍽️' },
  SIDE: { title: 'Podés sumar guarnición', emoji: '🥬' },
  DRINK: { title: 'Bebida que va bien', emoji: '🥤' },
  DESSERT: { title: 'Algo dulce para el cierre', emoji: '🍰' },
  OTHER: { title: 'Sugerencia', emoji: '✨' },
};

const TAG_BRIDGE_HINT: Record<MenuCategoryTag, string> = {
  STARTER: 'entradas',
  MAIN: 'platos principales',
  SIDE: 'guarniciones',
  DRINK: 'bebidas',
  DESSERT: 'postres',
  OTHER: 'opciones',
};

function buildFallbackBridgeMessage(
  lastItemName: string,
  nextTags: MenuCategoryTag[]
): string {
  const hints = nextTags.map((t) => TAG_BRIDGE_HINT[t] ?? 'opciones');
  const hintLabel =
    hints.length <= 1
      ? hints[0] ?? 'opciones'
      : `${hints.slice(0, -1).join(', ')} y ${hints[hints.length - 1]}`;
  return (
    `¡Genial! Ya sumaste ${wrapWhatsAppBold(lastItemName)}. Si querés, sumá ${hintLabel} que combinan bien.`
  );
}

function buildMultiTagTitle(nextTags: MenuCategoryTag[]): { title: string; emoji: string } {
  if (nextTags.length === 1) {
    const only = nextTags[0]!;
    return TAG_LABELS[only];
  }
  return {
    title: 'Podés seguir armando',
    emoji: TAG_LABELS[nextTags[0]!]?.emoji ?? '✨',
  };
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const MEANINGFUL_TAG_SET = new Set<string>(['STARTER', 'MAIN', 'SIDE', 'DRINK', 'DESSERT']);

function isMenuCategoryTag(v: unknown): v is MenuCategoryTag {
  return (
    v === 'STARTER' ||
    v === 'MAIN' ||
    v === 'SIDE' ||
    v === 'DRINK' ||
    v === 'DESSERT' ||
    v === 'OTHER'
  );
}

async function loadExcludeProductIds(draftOrderId: string): Promise<string[]> {
  const lines = await prisma.draft_order_item.findMany({
    where: { draft_order_id: draftOrderId, product_id: { not: null } },
    select: { product_id: true },
  });
  return lines.map((l) => l.product_id).filter((id): id is string => id != null);
}

function buildCartSummaryForPrompt(
  lines: Array<{ name: string; tag: MenuCategoryTag | null }>
): string {
  if (lines.length === 0) return '(carrito vacío)';
  return lines
    .map((l) => `- ${l.name}${l.tag ? ` [${l.tag}]` : ''}`)
    .join('\n');
}

async function loadDraftLineSummaries(
  draftOrderId: string,
  businessId: string
): Promise<Array<{ name: string; tag: MenuCategoryTag | null }>> {
  const rows = await prisma.draft_order_item.findMany({
    where: {
      draft_order_id: draftOrderId,
      product_id: { not: null },
      menu_item: { business_id: businessId },
    },
    select: {
      menu_item: {
        select: {
          name: true,
          menu_category: { select: { category_tag: true, is_active: true } },
        },
      },
    },
  });
  return rows.map((r) => {
    const cat = r.menu_item?.menu_category;
    const raw = cat?.category_tag;
    const tag =
      cat?.is_active && raw && MEANINGFUL_TAG_SET.has(raw)
        ? (raw as MenuCategoryTag)
        : null;
    return { name: r.menu_item?.name ?? 'Ítem', tag };
  });
}

/** Hasta `perTagLimit` productos por cada tag faltante (un solo prompt con todo el catálogo candidato). */
async function fetchMultiTagCandidatePool(params: {
  businessId: string;
  tags: MenuCategoryTag[];
  excludeProductIds: string[];
  perTagLimit: number;
}): Promise<ComplementaryMenuItemSummary[]> {
  const { businessId, tags, excludeProductIds, perTagLimit } = params;
  const seen = new Set<string>();
  const out: ComplementaryMenuItemSummary[] = [];
  for (const tag of tags) {
    const rows = await fetchComplementaryMenuItems({
      businessId,
      tags: [tag],
      excludeProductIds,
      limit: perTagLimit,
    });
    for (const row of rows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        out.push(row);
      }
    }
  }
  return out;
}

function applyOrderedIdsToPool(
  tagPool: ComplementaryMenuItemSummary[],
  orderedIds: string[]
): ComplementaryMenuItemSummary[] {
  if (tagPool.length <= 1) return tagPool;
  const byId = new Map(tagPool.map((i) => [i.id, i]));
  const ordered: ComplementaryMenuItemSummary[] = [];
  const seen = new Set<string>();
  for (const id of orderedIds) {
    const row = byId.get(id);
    if (row && !seen.has(id)) {
      ordered.push(row);
      seen.add(id);
    }
  }
  for (const p of tagPool) {
    if (!seen.has(p.id)) {
      ordered.push(p);
      seen.add(p.id);
    }
  }
  return ordered;
}

export type LlmMenuStepResult =
  | { skip: true; reason?: string }
  | {
      skip: false;
      nextTags: MenuCategoryTag[];
      pitch: string;
      orderedIds: string[];
      bridgeMessage: string;
    };

const MAX_OFFER_TAGS = 2;

function parseNextTags(
  obj: Record<string, unknown>,
  missingOrdered: MenuCategoryTag[]
): MenuCategoryTag[] | null {
  const fromArray = Array.isArray(obj.nextTags) ? obj.nextTags : null;
  // Compat: respuestas viejas con nextTag único.
  const legacy = obj.nextTag;
  const raw: unknown[] = fromArray ?? (legacy != null ? [legacy] : []);
  const tags: MenuCategoryTag[] = [];
  for (const t of raw) {
    if (!isMenuCategoryTag(t) || t === 'OTHER' || t === 'SIDE') continue;
    if (!missingOrdered.includes(t)) continue;
    if (!tags.includes(t)) tags.push(t);
    if (tags.length >= MAX_OFFER_TAGS) break;
  }
  return tags.length > 0 ? tags : null;
}

/**
 * Una sola llamada: decide omitir o elegir hasta 2 tags, pitch y orden de productos.
 */
async function llmMenuStepUnified(params: {
  business: Business;
  missingOrdered: MenuCategoryTag[];
  cartSummary: string;
  lastItemName: string;
  lastItemTag: MenuCategoryTag | null;
  catalog: ComplementaryMenuItemSummary[];
}): Promise<LlmMenuStepResult | null> {
  const { business, missingOrdered, cartSummary, lastItemName, lastItemTag, catalog } = params;
  if (missingOrdered.length === 0 || catalog.length === 0) return null;

  const allowed = missingOrdered.join(', ');
  const catalogLines = catalog
    .map((i) => `- ${i.id} | ${i.categoryTag} | ${i.name}`)
    .join('\n');

  const { promptText } = await resolvePersonalityForBusiness(business.id);
  const system = `${buildComplementarySuggestionSystemPrompt(promptText)}

Tags permitidos en este turno (máx 2 en nextTags): [${allowed}]

Último producto agregado por el cliente: "${lastItemName}"${lastItemTag ? ` (tag categoría: ${lastItemTag})` : ''}`;

  const user = `Carrito actual:
${cartSummary}

Último producto agregado: "${lastItemName}"${lastItemTag ? ` (tag categoría: ${lastItemTag})` : ''}

Tags aún no cubiertos (elegí hasta 2 como nextTags; si no encaja, skip): ${allowed}

Catálogo candidato (id | tag | nombre):
${catalogLines}`;

  const { content } = await generateAIResponse(business, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);

  if (
    content.includes('🚫') ||
    content.includes('⚡') ||
    content.includes('⏳')
  ) {
    return null;
  }

  const obj = parseJsonObject(content);
  if (!obj) return null;

  if (obj.skip === true) {
    const reason = typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 200) : undefined;
    return { skip: true, ...(reason ? { reason } : {}) };
  }

  const nextTags = parseNextTags(obj, missingOrdered);
  const pitch = obj.pitch;
  const bridgeRaw = obj.bridgeMessage;
  const orderedIdsRaw = obj.orderedIds;
  if (!nextTags || typeof pitch !== 'string') {
    return null;
  }
  const pitchTrim = normalizeWhatsAppBoldMarkers(pitch.trim());
  if (pitchTrim.length < 10) return null;

  let bridgeTrim =
    typeof bridgeRaw === 'string' ? normalizeWhatsAppBoldMarkers(bridgeRaw.trim()) : '';
  if (bridgeTrim.length < 25 || bridgeTrim.length > 600) {
    bridgeTrim = buildFallbackBridgeMessage(lastItemName, nextTags);
  }

  const tagSet = new Set(nextTags);
  const tagPool = catalog.filter((i) => tagSet.has(i.categoryTag));
  if (tagPool.length === 0) return null;

  let orderedIds: string[] = [];
  if (Array.isArray(orderedIdsRaw)) {
    orderedIds = orderedIdsRaw.filter((x): x is string => typeof x === 'string');
  }

  const validIds = new Set(tagPool.map((i) => i.id));
  orderedIds = orderedIds.filter((id) => validIds.has(id));
  const ordered = applyOrderedIdsToPool(tagPool, orderedIds);

  return {
    skip: false,
    nextTags,
    pitch: pitchTrim.slice(0, 500),
    bridgeMessage: bridgeTrim.slice(0, 600),
    orderedIds: ordered.map((i) => i.id),
  };
}

export type ComplementSuggestionBundle = {
  snapshot: ComplementSuggestionSnapshot;
  /** Texto plano para envolver con formatBotUserMessage en el mensaje de botones. */
  bridgeMessagePlain: string;
  items: ComplementaryMenuItemSummary[];
};

/**
 * Hasta 2 tags por ola: IA elige nextTags, pitch y orden (si IA disponible).
 */
export async function buildComplementarySuggestionsWithLlm(
  business: Business,
  params: BuildComplementarySuggestionsParams & { poolSize?: number }
): Promise<ComplementSuggestionBundle | null> {
  const { businessId, draftOrderId, lastAddedMenuItemId, maxItems = 6, poolSize = 12 } =
    params;

  const [lastTag, cartTags, lineSummaries] = await Promise.all([
    getMenuItemCategoryTag(lastAddedMenuItemId, businessId),
    collectCategoryTagsInDraftCart(draftOrderId, businessId),
    loadDraftLineSummaries(draftOrderId, businessId),
  ]);

  const lastItem = await prisma.menu_item.findFirst({
    where: { id: lastAddedMenuItemId, business_id: businessId },
    select: { name: true },
  });
  const lastItemName = lastItem?.name ?? 'Producto';

  const missingOrdered = getMissingMenuCompleteTags(cartTags);
  if (missingOrdered.length === 0) {
    return null;
  }

  const excludeProductIds = await loadExcludeProductIds(draftOrderId);
  const cartSummary = buildCartSummaryForPrompt(lineSummaries);

  const fallbackTags = pickFallbackNextTags(missingOrdered, MAX_OFFER_TAGS);
  if (fallbackTags.length === 0) {
    return null;
  }

  const perTagLimit = Math.min(
    4,
    Math.max(2, Math.ceil(poolSize / Math.max(1, missingOrdered.length)))
  );
  const multiPool = await fetchMultiTagCandidatePool({
    businessId,
    tags: missingOrdered,
    excludeProductIds,
    perTagLimit,
  });

  if (multiPool.length === 0) {
    return null;
  }

  const useAi = business.openai_active !== false && !business.ai_blocked;

  let nextTags: MenuCategoryTag[];
  let pitch: string;
  let bridgePlain: string;
  let ordered: ComplementaryMenuItemSummary[];

  if (useAi) {
    let unified: LlmMenuStepResult | null = null;
    try {
      unified = await llmMenuStepUnified({
        business,
        missingOrdered,
        cartSummary,
        lastItemName,
        lastItemTag: lastTag,
        catalog: multiPool,
      });
    } catch {
      return null;
    }
    if (!unified || unified.skip) {
      return null;
    }
    nextTags = unified.nextTags;
    pitch = unified.pitch;
    bridgePlain = unified.bridgeMessage;
    const tagSet = new Set(nextTags);
    const tagPool = multiPool.filter((i) => tagSet.has(i.categoryTag));
    ordered =
      tagPool.length > 0
        ? applyOrderedIdsToPool(tagPool, unified.orderedIds)
        : await fetchComplementaryMenuItems({
            businessId,
            tags: nextTags,
            excludeProductIds,
            limit: poolSize,
          });
  } else {
    nextTags = fallbackTags;
    pitch =
      'Si querés, podés mirar la lista: son opciones que van bien con lo que ya elegiste 👇';
    bridgePlain = buildFallbackBridgeMessage(lastItemName, nextTags);
    const tagSet = new Set(nextTags);
    ordered = multiPool.filter((i) => tagSet.has(i.categoryTag));
    if (ordered.length === 0) {
      ordered = await fetchComplementaryMenuItems({
        businessId,
        tags: nextTags,
        excludeProductIds,
        limit: poolSize,
      });
    }
  }

  if (ordered.length === 0) {
    return null;
  }

  // Intercalar por tag para que ambas secciones tengan filas (límite WA ~10 filas).
  const perTagCap = Math.max(2, Math.floor(maxItems / Math.max(1, nextTags.length)));
  const byTag = new Map<MenuCategoryTag, ComplementaryMenuItemSummary[]>();
  for (const item of ordered) {
    const list = byTag.get(item.categoryTag) ?? [];
    if (list.length < perTagCap) {
      list.push(item);
      byTag.set(item.categoryTag, list);
    }
  }
  const items: ComplementaryMenuItemSummary[] = [];
  for (const tag of nextTags) {
    items.push(...(byTag.get(tag) ?? []));
  }
  if (items.length === 0) {
    return null;
  }

  const label = buildMultiTagTitle(nextTags);
  const orderedItemIds = items.map((i) => i.id);

  const snapshot: ComplementSuggestionSnapshot = {
    v: 1,
    draftOrderId,
    businessId,
    orderedItemIds,
    pitchBody: pitch,
    title: label.title,
    titleEmoji: label.emoji,
    createdAtIso: new Date().toISOString(),
  };

  return {
    snapshot,
    bridgeMessagePlain: bridgePlain,
    items,
  };
}
