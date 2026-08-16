/**
 * Resuelve los nombres de producto que dijo el dueño contra el catálogo real
 * del negocio (PLAN-ACCION-PROMOCIONES-PERSISTENCIA.md, D3/D4).
 *
 * Propone, no decide: devuelve candidatos con score y el panel confirma. Solo
 * un match exacto y único se marca `resolved`, y aun así el admin lo ve y puede
 * cambiarlo.
 *
 * Orden de resolución (D4):
 *   1. exacto por `name` normalizado o por una de sus `variations`
 *   2. `contains` en cualquiera de los dos sentidos
 *   3. semántica pgvector (`MenuService.searchMenuItemsByKeyword`)
 *
 * La normalización (lowercase, sin acentos, sin plural simple) es solo para
 * COMPARAR. Lo que se muestra siempre es el nombre real del catálogo.
 */

import { prisma } from '../../lib/prisma';
import { MenuService } from '../menu.service';
import {
  activePriceSelect,
  getBusinessCurrencyCode,
} from '../../helpers/menuItemPrice.helper';
import type {
  PromotionEntityCandidate,
  UnresolvedEntity,
} from './promotionOffer.types';

/** Tope de catálogo cargado en memoria para comparar sin depender de `unaccent`. */
const CATALOG_LIMIT = 500;
const MAX_CANDIDATES_PER_ENTITY = 5;

type CatalogItem = {
  id: string;
  name: string;
  thumbnailUrl: string | null;
  variations: string[];
  price: number | null;
  currencyCode: string | null;
  normalizedName: string;
  normalizedVariations: string[];
};

export type ResolvedEntity = {
  entity: UnresolvedEntity;
  candidates: PromotionEntityCandidate[];
  /** `true` solo con un único match exacto (D3). */
  resolved: boolean;
};

export function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Quita plurales simples del español para que "papas" matchee "papa". */
function singularize(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith('ces')) return `${token.slice(0, -3)}z`;
  if (token.endsWith('es')) return token.slice(0, -2);
  if (token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function matchKey(value: string): string {
  return normalizeForMatch(value)
    .split(' ')
    .filter(Boolean)
    .map(singularize)
    .join(' ');
}

async function loadCatalog(businessId: string): Promise<CatalogItem[]> {
  const currency = await getBusinessCurrencyCode(businessId);

  const rows = await prisma.menu_item.findMany({
    where: { business_id: businessId, is_available: true },
    orderBy: { name: 'asc' },
    take: CATALOG_LIMIT,
    select: {
      id: true,
      name: true,
      image: true,
      variations: true,
      menu_item_price: activePriceSelect(currency),
    },
  });

  return rows.map((row) => {
    const price = row.menu_item_price[0];
    const variations = row.variations ?? [];
    return {
      id: row.id,
      name: row.name,
      thumbnailUrl: row.image ?? null,
      variations,
      price: price ? Number(price.amount) : null,
      currencyCode: price?.currency_code ?? null,
      normalizedName: matchKey(row.name),
      normalizedVariations: variations.map((variation) => matchKey(variation)),
    };
  });
}

function toCandidate(
  item: CatalogItem,
  params: {
    score: number;
    source: PromotionEntityCandidate['source'];
    matchedVariation?: string | null;
  }
): PromotionEntityCandidate {
  return {
    menuItemId: item.id,
    name: item.name,
    thumbnailUrl: item.thumbnailUrl,
    price: item.price,
    currencyCode: item.currencyCode,
    score: Number(params.score.toFixed(3)),
    source: params.source,
    matchedVariation: params.matchedVariation ?? null,
  };
}

/** Score de `contains`: cuánto del nombre del catálogo cubre lo que dijo el dueño. */
function containsScore(query: string, target: string): number {
  const ratio =
    Math.min(query.length, target.length) / Math.max(query.length, target.length);
  return 0.5 + ratio * 0.3;
}

function findExactAndContains(
  query: string,
  catalog: CatalogItem[]
): { exact: PromotionEntityCandidate[]; contains: PromotionEntityCandidate[] } {
  const key = matchKey(query);
  const exact: PromotionEntityCandidate[] = [];
  const contains: PromotionEntityCandidate[] = [];

  if (!key) return { exact, contains };

  for (const item of catalog) {
    if (item.normalizedName === key) {
      exact.push(toCandidate(item, { score: 1, source: 'exact' }));
      continue;
    }

    const variationIndex = item.normalizedVariations.indexOf(key);
    if (variationIndex >= 0) {
      exact.push(
        toCandidate(item, {
          score: 1,
          source: 'exact',
          matchedVariation: item.variations[variationIndex] ?? null,
        })
      );
      continue;
    }

    if (item.normalizedName.includes(key) || key.includes(item.normalizedName)) {
      contains.push(
        toCandidate(item, {
          score: containsScore(key, item.normalizedName),
          source: 'contains',
        })
      );
    }
  }

  contains.sort((a, b) => b.score - a.score);
  return { exact, contains };
}

async function findSemantic(
  businessId: string,
  query: string,
  catalog: CatalogItem[]
): Promise<PromotionEntityCandidate[]> {
  const byId = new Map(catalog.map((item) => [item.id, item]));

  try {
    const results = await MenuService.searchMenuItemsByKeyword({
      businessId,
      keyword: query,
    });

    const candidates: PromotionEntityCandidate[] = [];
    for (const result of results) {
      const item = byId.get(result.id);
      if (!item) continue;
      const distance = typeof result.distance === 'number' ? result.distance : 1;
      candidates.push(
        toCandidate(item, {
          score: Math.max(0, Math.min(1, 1 - distance)),
          source: 'semantic',
        })
      );
    }
    return candidates;
  } catch (error) {
    // Sin embeddings / sin cuota: degradamos a exacto + contains en vez de fallar.
    console.error(
      JSON.stringify({
        event: '[promotion-resolve] semantic_search_failed',
        businessId,
        error: String(error),
      })
    );
    return [];
  }
}

function dedupeByMenuItem(
  candidates: PromotionEntityCandidate[]
): PromotionEntityCandidate[] {
  const seen = new Set<string>();
  const out: PromotionEntityCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.menuItemId)) continue;
    seen.add(candidate.menuItemId);
    out.push(candidate);
  }
  return out;
}

/**
 * Busca candidatos del menú para cada entidad detectada por el intérprete.
 * Nunca lanza: si el catálogo no se puede leer, devuelve entidades sin candidatos.
 */
export async function resolveProductEntities(params: {
  businessId: string;
  entities: UnresolvedEntity[];
}): Promise<ResolvedEntity[]> {
  const { businessId, entities } = params;
  const productEntities = entities.filter((entity) => entity.type === 'product');

  if (productEntities.length === 0) {
    return entities.map((entity) => ({ entity, candidates: [], resolved: false }));
  }

  let catalog: CatalogItem[];
  try {
    catalog = await loadCatalog(businessId);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: '[promotion-resolve] catalog_load_failed',
        businessId,
        error: String(error),
      })
    );
    return entities.map((entity) => ({ entity, candidates: [], resolved: false }));
  }

  const resolved: ResolvedEntity[] = [];

  for (const entity of entities) {
    if (entity.type !== 'product') {
      resolved.push({ entity, candidates: [], resolved: false });
      continue;
    }

    const { exact, contains } = findExactAndContains(entity.text, catalog);

    let candidates = dedupeByMenuItem([...exact, ...contains]);
    if (exact.length === 0 && contains.length === 0) {
      candidates = dedupeByMenuItem(
        await findSemantic(businessId, entity.text, catalog)
      );
    }

    resolved.push({
      entity,
      candidates: candidates.slice(0, MAX_CANDIDATES_PER_ENTITY),
      resolved: exact.length === 1,
    });
  }

  console.log(
    JSON.stringify({
      event: '[promotion-resolve] done',
      businessId,
      catalogSize: catalog.length,
      entities: resolved.map((item) => ({
        text: item.entity.text,
        resolved: item.resolved,
        candidateCount: item.candidates.length,
        topSource: item.candidates[0]?.source ?? null,
      })),
    })
  );

  return resolved;
}
