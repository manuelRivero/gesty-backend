import type { business as Business, MenuCategoryTag } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { generateAIResponse } from '../ai/openai.service';
import { resolvePersonalityForBusiness } from '../botPersonality.service';
import { buildFoodRecommenderSystemPrompt } from '../../prompts/botPersonality';
import { MenuService, type MenuItemSearchResult } from '../menu.service';
import type { RecommendationCartSummary } from './recommendationCartSummary';
import { computeMainPortionCoverageFromDraft } from './recommendationCartSummary';
import {
  type NextActionFlowPhase,
  type NextActionHintKey,
  type NextActionHintsShown,
  forcedCategoryTagForFlowPhase,
  getNextActionBannerMessage,
  resolveNextActionFlowPhase,
} from './nextActionAfterMains';

export type FoodRecommenderCandidate = {
  id: string;
  name: string;
  description: string | null;
  category: string;
  /** Personas por porción según ficha (null = no indicado). */
  serves_people: number | null;
  /** Etiqueta de categoría del menú (p. ej. MAIN). */
  category_tag: MenuCategoryTag | null;
};

export type SmartFoodRecommendation = {
  id: string;
  name: string;
  description: string | null;
  reason: string;
  /** Cantidad sugerida para agregar (1 si no aplica). */
  suggestedQuantity?: number;
  /** Porciones según ficha; solo para texto y cantidad sugerida, sin inventar. */
  serves_people?: number | null;
};

export type GetSmartRecommendationsResult = {
  forDisplay: SmartFoodRecommendation[];
  /** Listado WhatsApp: alineado con el LLM (mismos ids y orden); en fallback, top 3 del vector. */
  forList: SmartFoodRecommendation[];
  usedLlm: boolean;
  /** Mensaje contextual opcional del LLM (porciones, cantidad, guía). Sin plantillas en código. */
  llmNote?: string | null;
  /** Resumen corto del estado del pedido / progreso (solo si el LLM lo devuelve). */
  llmProgress?: string | null;
  /** Reservado; ya no se antepone texto de cobertura MAIN al bloque de resultados. */
  mainCoverageGuidance?: string | null;
  /** Banner de flujo post-principales (bebida → entrada → postre → cierre). */
  nextActionMessage?: string | null;
  /** Si se mostró un banner, persistir en metadata.nextActionHintsShown. */
  nextActionHintKey?: NextActionHintKey | null;
  /** Fase actual del flujo (debug / UI). */
  nextActionFlowPhase?: NextActionFlowPhase;
};

const MAX_CANDIDATES_FOR_LLM = 10;
const MAX_LLM_PICKS = 3;
/** WhatsApp interactive list: max rows per section (API limit). */
export const MAX_WHATSAPP_LIST_ROWS = 10;
const TOP_FALLBACK_DISPLAY = 3;
const MAX_NOTE_LENGTH = 500;
const MAX_PROGRESS_LENGTH = 400;

const FALLBACK_REASON = 'Buena coincidencia con tu búsqueda.';

function stripCodeFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
}

type ParsedLlmRecommender = {
  recommendations: Array<{
    id: string;
    reason: string;
    suggestedQuantity?: number;
  }>;
  note: string | null;
  progress: string | null;
};

function clampSuggestedQuantity(n: unknown): number | undefined {
  if (n === null || n === undefined) return undefined;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  const i = Math.floor(n);
  if (i < 1) return undefined;
  return Math.min(99, i);
}

function tryParseSmartRecommenderJson(raw: string): ParsedLlmRecommender | null {
  const trimmed = stripCodeFences(raw);
  try {
    const obj = JSON.parse(trimmed) as unknown;
    if (!obj || typeof obj !== 'object') return null;
    const recs = (obj as { recommendations?: unknown }).recommendations;
    if (!Array.isArray(recs)) return null;
    const out: ParsedLlmRecommender['recommendations'] = [];
    const seenIds = new Set<string>();
    for (const r of recs) {
      if (!r || typeof r !== 'object') continue;
      const id = (r as { id?: unknown }).id;
      const reason = (r as { reason?: unknown }).reason;
      if (typeof id !== 'string' || typeof reason !== 'string') continue;
      const idTrim = id.trim();
      if (idTrim.length === 0 || seenIds.has(idTrim)) continue;
      const reasonTrim = reason.trim();
      if (reasonTrim.length === 0) continue;
      seenIds.add(idTrim);
      const sq = clampSuggestedQuantity((r as { suggestedQuantity?: unknown }).suggestedQuantity);
      out.push({
        id: idTrim,
        reason: reasonTrim,
        ...(sq != null && sq > 1 ? { suggestedQuantity: sq } : {}),
      });
    }
    if (out.length === 0) return null;

    let note: string | null = null;
    if ('note' in obj) {
      const n = (obj as { note?: unknown }).note;
      if (n === null || n === undefined) {
        note = null;
      } else if (typeof n === 'string') {
        const t = n.trim();
        note = t.length > 0 ? t.slice(0, MAX_NOTE_LENGTH) : null;
      }
    }

    let progress: string | null = null;
    if ('progress' in obj) {
      const p = (obj as { progress?: unknown }).progress;
      if (p === null || p === undefined) {
        progress = null;
      } else if (typeof p === 'string') {
        const t = p.trim();
        progress = t.length > 0 ? t.slice(0, MAX_PROGRESS_LENGTH) : null;
      }
    }

    return { recommendations: out, note, progress };
  } catch {
    return null;
  }
}

/** Solo deduplicación técnica por id (preserva orden del vector). */
function dedupeById(items: MenuItemSearchResult[]): MenuItemSearchResult[] {
  const seen = new Set<string>();
  const out: MenuItemSearchResult[] = [];
  for (const item of items) {
    const id = String(item.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

export function dedupeMenuItemSearchResultsById(
  items: MenuItemSearchResult[]
): MenuItemSearchResult[] {
  return dedupeById(items);
}

function dedupeSmartRecommendationsById(
  recs: SmartFoodRecommendation[]
): SmartFoodRecommendation[] {
  const seen = new Set<string>();
  const out: SmartFoodRecommendation[] = [];
  for (const r of recs) {
    const id = (r.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(r);
  }
  return out;
}

/**
 * Nombres/description desde el vector; descarta entradas sin id válido.
 * Máximo MAX_WHATSAPP_LIST_ROWS ítems (límite WhatsApp).
 */
function finalizeRecommendationsForWhatsAppList(
  recs: SmartFoodRecommendation[],
  byIdVector: Map<string, MenuItemSearchResult>
): SmartFoodRecommendation[] {
  const deduped = dedupeSmartRecommendationsById(recs);
  const out: SmartFoodRecommendation[] = [];
  for (const r of deduped) {
    if (out.length >= MAX_WHATSAPP_LIST_ROWS) break;
    const id = (r.id ?? '').trim();
    if (!id) continue;
    const src = byIdVector.get(id);
    const name = (src?.name ?? r.name ?? '').trim() || 'Producto';
    out.push({
      ...r,
      id,
      name,
      description: src?.description ?? r.description ?? null,
      serves_people: src?.serves_people ?? r.serves_people ?? null,
    });
  }
  return out;
}

function finalizeVectorItemsForWhatsAppList(
  items: MenuItemSearchResult[]
): MenuItemSearchResult[] {
  const deduped = dedupeById(items);
  const out: MenuItemSearchResult[] = [];
  for (const item of deduped) {
    if (out.length >= MAX_WHATSAPP_LIST_ROWS) break;
    const id = (item.id ?? '').trim();
    if (!id) continue;
    const name = (item.name ?? '').trim() || 'Producto';
    out.push({ ...item, id, name });
  }
  return out;
}

type CategoryMeta = { name: string; tag: MenuCategoryTag | null };

async function loadCategoryMetadataByItemId(
  businessId: string,
  ids: string[]
): Promise<Map<string, CategoryMeta>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.menu_item.findMany({
    where: { id: { in: ids }, business_id: businessId },
    select: {
      id: true,
      menu_category: { select: { name: true, category_tag: true } },
    },
  });
  return new Map(
    rows.map((r) => [
      r.id,
      {
        name: r.menu_category?.name?.trim() || 'Sin categoría',
        tag: r.menu_category?.category_tag ?? null,
      },
    ])
  );
}

function filterVectorToCategoryTag(
  items: MenuItemSearchResult[],
  metaById: Map<string, CategoryMeta>,
  tag: MenuCategoryTag | null
): MenuItemSearchResult[] {
  if (tag == null) return items;
  return items.filter((i) => metaById.get(i.id)?.tag === tag);
}

async function fetchMenuItemsByCategoryTag(
  businessId: string,
  categoryTag: MenuCategoryTag,
  limit: number
): Promise<MenuItemSearchResult[]> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { currency_code: true },
  });
  const currency = business?.currency_code ?? null;
  const now = new Date();
  const priceWhere = {
    is_active: true,
    valid_from: { lte: now },
    OR: [{ valid_to: null }, { valid_to: { gte: now } }],
    ...(currency ? { currency_code: currency } : {}),
  };

  const rows = await prisma.menu_item.findMany({
    where: {
      business_id: businessId,
      is_available: true,
      menu_category: { category_tag: categoryTag, is_active: true },
      menu_item_price: { some: priceWhere },
    },
    orderBy: { created_at: 'asc' },
    take: limit,
    select: {
      id: true,
      name: true,
      description: true,
      ingredients: true,
      serves_people: true,
      is_available: true,
      menu_item_price: {
        where: priceWhere,
        orderBy: { valid_from: 'desc' },
        take: 1,
        select: { amount: true, currency_code: true },
      },
    },
  });

  return rows as MenuItemSearchResult[];
}

function menuResultsToSmart(
  items: MenuItemSearchResult[],
  reason: string
): SmartFoodRecommendation[] {
  return items.map((i) => ({
    id: i.id,
    name: i.name,
    description: i.description,
    reason,
    serves_people: i.serves_people ?? null,
  }));
}

export type PortionCase = 'enough' | 'not_enough' | 'unknown';

/** Clasificación solo con datos de ficha; sin asumir si falta serves_people. */
export function classifyPortionVsParty(
  servesPeople: number | null | undefined,
  requestedPartySize: number
): PortionCase {
  if (requestedPartySize <= 0) return 'unknown';
  if (servesPeople == null || servesPeople <= 0) return 'unknown';
  if (servesPeople >= requestedPartySize) return 'enough';
  return 'not_enough';
}

/**
 * Texto breve según serves_people vs comensales (un solo plato).
 * Sin referencias al carrito ni estados internos.
 */
export function formatSingleProductPortionHint(
  servesPeople: number | null | undefined,
  partySize: number | null | undefined
): string {
  const party = partySize != null && partySize > 0 ? partySize : null;
  if (party == null) return '';

  const sp = servesPeople != null && servesPeople > 0 ? servesPeople : null;
  if (sp == null) {
    return 'Podés elegir esta opción y, según el tamaño, sumar más unidades si querés 👇';
  }
  if (sp >= party) {
    return `Este plato puede alcanzar para ${party} persona${party === 1 ? '' : 's'} 👍`;
  }
  if (sp === 1) {
    return `Es por porción individual; para ${party} persona${party === 1 ? '' : 's'} podés sumar varias unidades 👇`;
  }
  return `Una porción alcanza hasta ${sp} persona${sp === 1 ? '' : 's'}; para ${party} podés pedir más de una unidad si querés 👇`;
}

/**
 * Bloque de aclaración de porciones tras la lista de recomendaciones (determinístico).
 * Máx. ~2 frases cortas en casos uniformes; mezclas: un párrafo compacto.
 */
export function buildPortionClarificationForRecommendations(
  recommendations: SmartFoodRecommendation[],
  requestedPartySize: number | null | undefined
): string {
  const party =
    requestedPartySize != null && requestedPartySize > 0
      ? requestedPartySize
      : null;
  if (party == null || recommendations.length === 0) return '';

  const cases = recommendations.map((r) => ({
    name: r.name,
    serves: r.serves_people ?? null,
    kind: classifyPortionVsParty(r.serves_people, party),
  }));

  const allEnough = cases.every((c) => c.kind === 'enough');
  const allNotEnough = cases.every((c) => c.kind === 'not_enough');
  const allUnknown = cases.every((c) => c.kind === 'unknown');

  if (allEnough) {
    return recommendations.length === 1
      ? `Este plato puede alcanzar para ${party} persona${party === 1 ? '' : 's'} 👍`
      : `Estas opciones pueden alcanzar para ${party} persona${party === 1 ? '' : 's'} 👍`;
  }

  if (allNotEnough) {
    const allIndividual = cases.every((c) => c.serves === 1);
    if (allIndividual && recommendations.length >= 2) {
      return `Cada plato es individual, así que para ${party} persona${party === 1 ? '' : 's'} podés sumar varias unidades 👇`;
    }
    if (allIndividual && recommendations.length === 1) {
      return `Es por porción individual; para ${party} persona${party === 1 ? '' : 's'} podés sumar varias unidades 👇`;
    }
    const sp0 = cases[0].serves;
    if (recommendations.length === 1 && sp0 != null && sp0 > 1) {
      return `Una porción alcanza hasta ${sp0} persona${sp0 === 1 ? '' : 's'}; para ${party} podés pedir más de una unidad si querés 👇`;
    }
    return `Según la ficha, si querés cubrir a ${party} persona${party === 1 ? '' : 's'}, podés sumar más de una unidad 👇`;
  }

  if (allUnknown) {
    return recommendations.length === 1
      ? 'Podés elegir esta opción y, según el tamaño, sumar más unidades si querés 👇'
      : 'Podés elegir de la lista y, según el tamaño, sumar más unidades si querés 👇';
  }

  const lines = cases.map((c) => {
    if (c.kind === 'enough') {
      return `• ${c.name}: puede alcanzar para ${party} persona${party === 1 ? '' : 's'} 👍`;
    }
    if (c.kind === 'not_enough') {
      if (c.serves === 1) {
        return `• ${c.name}: porción individual; para ${party} podés sumar varias unidades 👇`;
      }
      if (c.serves != null && c.serves > 0) {
        return `• ${c.name}: una porción alcanza hasta ${c.serves} persona${c.serves === 1 ? '' : 's'}; para ${party} podés sumar más de una unidad si querés 👇`;
      }
    }
    return `• ${c.name}: podés ajustar unidades según el tamaño 👇`;
  });
  return lines.join('\n');
}

function resolveSuggestedQuantityFromPortion(
  servesPeople: number | null | undefined,
  party: number | null | undefined,
  fromLlm: number | undefined
): number | undefined {
  if (party != null && party > 0 && servesPeople != null && servesPeople > 0) {
    const need = Math.ceil(party / servesPeople);
    if (need > 1) return Math.min(99, need);
    return undefined;
  }
  if (fromLlm != null && fromLlm > 1) return Math.min(99, fromLlm);
  return undefined;
}

/** Unidades sugeridas en payload de lista (≥2); si una porción alcanza, undefined. */
export function suggestedUnitsForListRow(
  servesPeople: number | null | undefined,
  party: number | null | undefined
): number | undefined {
  if (party == null || party <= 0) return undefined;
  if (servesPeople == null || servesPeople <= 0) return undefined;
  const need = Math.ceil(party / servesPeople);
  return need >= 2 ? Math.min(99, need) : undefined;
}

/**
 * Prompt: intención, carrito, personas, ranking — todo decidido por el LLM.
 */
function strictCategoryGatePromptLines(tag: MenuCategoryTag | null): string {
  if (tag == null) return '';
  if (tag === 'MAIN') {
    return `\nPrioridad de este listado: platos principales (MAIN) para el grupo de comensales de referencia. Los candidatos son solo tag=MAIN. No sugieras bebidas, postres ni entradas; ayudá a elegir entre platos principales.\n`;
  }
  const label =
    tag === 'DRINK'
      ? 'bebidas'
      : tag === 'STARTER'
        ? 'entradas'
        : tag === 'DESSERT'
          ? 'postres'
          : 'esta categoría';
  return `\nEn este paso el listado es solo ${label} (tag=${tag}). No mezcles otras categorías en la elección.\n`;
}

function prioritizationBlock(strictTag: MenuCategoryTag | null): string {
  if (strictTag === 'MAIN') {
    return `- Priorizá solo platos principales (MAIN) para el grupo de referencia.\n- No ofrezcas bebidas, postres, entradas ni guarniciones aunque el resumen muestre 0 en otros rubros.`;
  }
  if (strictTag === 'DRINK') {
    return `- Solo bebidas (DRINK). No sugieras platos principales, entradas ni postres.`;
  }
  if (strictTag === 'STARTER') {
    return `- Solo entradas (STARTER). No sugieras principales, bebidas ni postres en esta elección.`;
  }
  if (strictTag === 'DESSERT') {
    return `- Solo postres (DESSERT). No sugieras principales, bebidas ni entradas en esta elección.`;
  }
  return `- Si hay hueco en algún tipo de plato y hay candidatos, podés incluir ese tipo.\n- Si ya hay bastante de un tipo, ofrecé variedad o bebida/postre según candidatos.`;
}

export function FOOD_RECOMMENDER_PROMPT(
  userQuery: string,
  candidates: FoodRecommenderCandidate[],
  requestedPartySize: number | null | undefined,
  cartSummary: RecommendationCartSummary,
  strictCategoryTag: MenuCategoryTag | null
): string {
  const lines = candidates
    .map((c, i) => {
      const desc = (c.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 220);
      const serves =
        c.serves_people != null && c.serves_people > 0
          ? String(c.serves_people)
          : '—';
      const tag = c.category_tag ?? '—';
      return `${i + 1}. id=${c.id} | categoría=${c.category} | tag=${tag} | nombre=${c.name} | sirve_a_personas_ficha=${serves}${desc ? ` | descripción=${desc}` : ''}`;
    })
    .join('\n');

  const partyLine =
    requestedPartySize != null && requestedPartySize > 0
      ? `Comensales de referencia (solo lo que el cliente dijo; no asumas que ya eligió platos): aproximadamente ${requestedPartySize}.`
      : 'Comensales de referencia: no indicado.';

  const cartJson = JSON.stringify(cartSummary);

  return `Sos el mozo virtual del restaurante por WhatsApp. Mensaje del cliente: "${userQuery}".

${partyLine}

CONTEXTO INTERNO (para elegir candidatos; NO lo repitas al cliente en reason, note ni progress):
${cartJson}
- starters/mains/drinks/desserts = unidades por tipo en el flujo actual; 0 = aún no sumó de ese tipo.
- Usá esto solo para priorizar variedad o huecos; no lo describas con jerga al usuario.
${strictCategoryGatePromptLines(strictCategoryTag)}

Tu tarea: elegir SOLO entre los candidatos de abajo y devolver JSON. El cliente ve reason, note y progress.

PORCIONES (campo sirve_a_personas_ficha en cada candidato):
- Ese número es el único dato de "cuántas personas alcanza una porción". Si es "—", no hay dato: NO inventes tamaños.
- NO repitas en note/progress el razonamiento de porciones: el mensaje ya llevará un bloque aparte según la ficha.
- En "reason" NO menciones personas, porciones ni "alcanza para N"; solo por qué el plato encaja con la búsqueda (una oración corta, tono venta).

VOZ (texto al cliente):
- Seguro, cercano, natural.
- NO menciones: borrador, carrito, JSON, sistema, "ítems", "ficha", "base de datos".
- NO uses: "podrías", "considerá", "tal vez", "no está de más".
- NUNCA digas "ya tenés", "tenés", "tu pedido tiene" ni asumas productos ya cargados.

CADA "reason" (una oración, corta):
- Solo encaje con la búsqueda; sin porciones ni comensales.

"note" y "progress" (opcionales):
- Juntos: máximo 2 oraciones cortas en total; si no suman, null ambos.
- Solo siguiente paso útil (elegir de la lista, seguir). Sin repetir platos ni porciones.

PRIORIZACIÓN (resumen interno):
${prioritizationBlock(strictCategoryTag)}

SELECCIÓN:
- Preferí 2 o 3 recomendaciones si hay buenos candidatos; una sola solo si el resto es irrelevante.

UNICIDAD:
- Cada id una sola vez en "recommendations".

TRUTH:
- Solo datos del candidato. No inventes ingredientes, alérgenos ni tiempos.

suggestedQuantity (opcional, 1–99 por ítem):
- Si sirve_a_personas_ficha es un número N y hay comensales de referencia C, podés sugerir ceil(C/N) unidades cuando una porción no alcanza; si alcanza con una, omití o 1.

REDUNDANCY:
- Cada "reason" distinta.

Candidatos (usá solo estos ids):
${lines}

Respondé SOLO JSON válido, sin markdown ni texto fuera del JSON, con esta forma:
{"recommendations":[{"id":"<uuid>","reason":"<una oración>","suggestedQuantity":2}],"note":null,"progress":null}
- "note" y "progress" pueden ser null o string; entre ambos, máximo 2 oraciones cortas en total.`;
}

/**
 * Vector search (retrieval) + deduplicación por id; ranking, textos y metadatos solo vía LLM.
 */
export async function getSmartRecommendations(params: {
  userQuery: string;
  businessId: string;
  business: Business;
  vectorResults?: MenuItemSearchResult[];
  /** Personas/comensales ya inferidos o guardados en sesión. */
  requestedPartySize?: number | null;
  /** Resumen de unidades en el borrador (por tipo de categoría). */
  cartSummary: RecommendationCartSummary;
  /** Teléfono del cliente para calcular cobertura MAIN en el borrador. */
  customerPhone?: string | null;
  /** Banners de flujo ya mostrados (no repetir). */
  nextActionHintsShown?: NextActionHintsShown | null;
}): Promise<GetSmartRecommendationsResult> {
  const { userQuery, businessId, business } = params;
  const trimmedUtterance = userQuery.trim();

  const peopleCount =
    params.requestedPartySize != null && params.requestedPartySize > 0
      ? params.requestedPartySize
      : null;

  let mainCoverage = 0;
  const phone = params.customerPhone?.trim();
  if (phone) {
    mainCoverage = await computeMainPortionCoverageFromDraft({
      businessId,
      customerPhone: phone,
    });
  }

  const flowPhase = resolveNextActionFlowPhase({
    peopleCount,
    mainCoverage,
    cartSummary: params.cartSummary,
  });

  const mainCoverageGuidance: string | null = null;

  const strictCategoryTag = forcedCategoryTagForFlowPhase(flowPhase);

  const banner = getNextActionBannerMessage(
    flowPhase,
    params.nextActionHintsShown ?? null
  );

  let vectorItems =
    params.vectorResults ??
    (await MenuService.searchMenuItemsByKeyword({
      businessId,
      keyword: trimmedUtterance,
    }));

  if (vectorItems.length === 0 && strictCategoryTag != null) {
    vectorItems = await fetchMenuItemsByCategoryTag(
      businessId,
      strictCategoryTag,
      25
    );
  }

  const baseResultFields = (): Pick<
    GetSmartRecommendationsResult,
    | 'mainCoverageGuidance'
    | 'nextActionMessage'
    | 'nextActionHintKey'
    | 'nextActionFlowPhase'
  > => ({
    mainCoverageGuidance,
    nextActionMessage: banner.message,
    nextActionHintKey: banner.hintKey,
    nextActionFlowPhase: flowPhase,
  });

  const emptyBase = (): GetSmartRecommendationsResult => ({
    forDisplay: [],
    forList: [],
    usedLlm: false,
    llmNote: null,
    llmProgress: null,
    ...baseResultFields(),
  });

  if (vectorItems.length === 0) {
    return emptyBase();
  }

  let deduped = dedupeById(vectorItems);

  let metaById = await loadCategoryMetadataByItemId(
    businessId,
    deduped.map((i) => i.id)
  );
  let workingSet = filterVectorToCategoryTag(
    deduped,
    metaById,
    strictCategoryTag
  );

  if (strictCategoryTag != null && workingSet.length === 0) {
    const fb = await fetchMenuItemsByCategoryTag(
      businessId,
      strictCategoryTag,
      25
    );
    workingSet = dedupeById(fb);
    metaById = await loadCategoryMetadataByItemId(
      businessId,
      workingSet.map((i) => i.id)
    );
  }

  if (workingSet.length === 0) {
    return emptyBase();
  }

  deduped = workingSet;

  const llmFailureResult = (): GetSmartRecommendationsResult => {
    const safeRows = finalizeVectorItemsForWhatsAppList(deduped).slice(
      0,
      TOP_FALLBACK_DISPLAY
    );
    return {
      forDisplay: menuResultsToSmart(safeRows, FALLBACK_REASON),
      forList: menuResultsToSmart(safeRows, ''),
      usedLlm: false,
      llmNote: null,
      llmProgress: null,
      ...baseResultFields(),
    };
  };

  const useAi =
    business.openai_active !== false &&
    !business.ai_blocked &&
    trimmedUtterance.length > 0;

  if (!useAi) {
    const safeRows = finalizeVectorItemsForWhatsAppList(deduped).slice(
      0,
      TOP_FALLBACK_DISPLAY
    );
    return {
      forDisplay: [],
      forList: menuResultsToSmart(safeRows, FALLBACK_REASON),
      usedLlm: false,
      llmNote: null,
      llmProgress: null,
      ...baseResultFields(),
    };
  }

  const topForLlm = deduped.slice(0, MAX_CANDIDATES_FOR_LLM);
  const ids = topForLlm.map((i) => i.id);

  const candidates: FoodRecommenderCandidate[] = topForLlm.map((row) => {
    const meta = metaById.get(row.id);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      category: meta?.name ?? 'Sin categoría',
      serves_people: row.serves_people ?? null,
      category_tag: meta?.tag ?? null,
    };
  });

  const allowed = new Set(ids);
  const byIdVector = new Map(topForLlm.map((r) => [r.id, r]));

  const suppressLlmNotes = strictCategoryTag != null;

  try {
    const { promptText } = await resolvePersonalityForBusiness(business.id);
    const system = buildFoodRecommenderSystemPrompt(promptText);
    const user = FOOD_RECOMMENDER_PROMPT(
      trimmedUtterance,
      candidates,
      params.requestedPartySize,
      params.cartSummary,
      strictCategoryTag
    );

    const { content } = await generateAIResponse(business, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);

    if (
      !content ||
      content.includes('🚫') ||
      content.includes('⚡') ||
      content.includes('⏳')
    ) {
      return llmFailureResult();
    }

    const parsed = tryParseSmartRecommenderJson(content);
    if (!parsed) {
      return llmFailureResult();
    }

    const pickedIds = new Set<string>();
    const picked: SmartFoodRecommendation[] = [];
    for (const row of parsed.recommendations) {
      if (
        !allowed.has(row.id) ||
        pickedIds.has(row.id) ||
        picked.length >= MAX_LLM_PICKS
      ) {
        continue;
      }
      const src = byIdVector.get(row.id);
      if (!src) continue;
      if (
        strictCategoryTag != null &&
        metaById.get(row.id)?.tag !== strictCategoryTag
      ) {
        continue;
      }
      pickedIds.add(row.id);
      const sq = resolveSuggestedQuantityFromPortion(
        src.serves_people,
        params.requestedPartySize,
        row.suggestedQuantity
      );
      picked.push({
        id: src.id,
        name: src.name,
        description: src.description,
        reason: row.reason.slice(0, 280),
        serves_people: src.serves_people ?? null,
        ...(sq != null && sq > 1 ? { suggestedQuantity: sq } : {}),
      });
    }

    const finalList = finalizeRecommendationsForWhatsAppList(picked, byIdVector);
    if (finalList.length === 0) {
      return llmFailureResult();
    }

    return {
      forDisplay: finalList,
      forList: finalList,
      usedLlm: true,
      llmNote: suppressLlmNotes ? null : parsed.note,
      llmProgress: suppressLlmNotes ? null : parsed.progress,
      ...baseResultFields(),
    };
  } catch {
    return llmFailureResult();
  }
}

/** Lista: nombre en bullet; motivo en línea siguiente (sin duplicar porciones aquí). */
export function formatSmartRecommendationsBullets(
  recommendations: SmartFoodRecommendation[]
): string {
  return formatSmartRecommendationsBulletLines(recommendations);
}

export function formatSmartRecommendationsBulletLines(
  recommendations: SmartFoodRecommendation[]
): string {
  return recommendations
    .map((r) => {
      const nameLine = `• ${r.name}`;
      const rsn = r.reason?.trim();
      return rsn ? `${nameLine}\n${rsn}` : nameLine;
    })
    .join('\n\n');
}

/**
 * Bullets → aclaración de porciones (ficha) → nota/progress del LLM (solo paso siguiente).
 * `requestedPartySize` alimenta el bloque determinístico de porciones.
 */
export function formatSmartRecommendationsBlock(
  recommendations: SmartFoodRecommendation[],
  llmNote?: string | null,
  llmProgress?: string | null,
  requestedPartySize?: number | null
): string {
  const bullets = formatSmartRecommendationsBulletLines(recommendations);
  const parts: string[] = [bullets];

  const portion = buildPortionClarificationForRecommendations(
    recommendations,
    requestedPartySize ?? null
  );
  if (portion) parts.push(portion);

  const n = llmNote?.trim();
  if (n) parts.push(n);
  const prog = llmProgress?.trim();
  if (prog) parts.push(prog);
  return parts.join('\n\n');
}
