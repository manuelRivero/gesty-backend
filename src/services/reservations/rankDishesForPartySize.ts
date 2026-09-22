/**
 * Ranking determinístico de platos para mesa (RES-05 / BOT-07 Fase 9).
 * Sin LLM: exact / near / cover / over. Unidades = ceil(N / serves) (D2).
 */

import { suggestAddQuantity } from '../addQuantitySuggestion';

export const DISH_PARTY_NEAR_MAX_EXTRA = 2;

export type DishPartyMatch = 'exact' | 'near' | 'cover' | 'over';

export type RankableDish = {
  id: string;
  name: string;
  serves_people: number | null;
  is_featured?: boolean;
};

export type DishPartyRankFields = {
  match: DishPartyMatch;
  suggestedUnits: number;
  covers: number;
  surplus: number;
  note: string;
};

export type RankedDishForParty<T extends RankableDish> = T & DishPartyRankFields;

const MATCH_RANK: Record<DishPartyMatch, number> = {
  exact: 0,
  near: 1,
  cover: 2,
  over: 3,
};

export const classifyDishForPartySize = (
  servesPeople: number,
  partySize: number
): DishPartyRankFields => {
  const serves = Math.max(1, Math.floor(servesPeople));
  const party = Math.max(1, Math.floor(partySize));

  if (serves === party) {
    return {
      match: 'exact',
      suggestedUnits: 1,
      covers: serves,
      surplus: 0,
      note: `ración exacta para ${party}`,
    };
  }

  if (serves > party && serves <= party + DISH_PARTY_NEAR_MAX_EXTRA) {
    return {
      match: 'near',
      suggestedUnits: 1,
      covers: serves,
      surplus: serves - party,
      note: `ración de ${serves} (sobra ${serves - party})`,
    };
  }

  if (serves < party) {
    const suggestedUnits = suggestAddQuantity({
      partySize: party,
      servesPeople: serves,
    }).suggestedQuantity;
    const covers = suggestedUnits * serves;
    return {
      match: 'cover',
      suggestedUnits,
      covers,
      surplus: covers - party,
      note: `${suggestedUnits}× ración de ${serves} → cubre ${covers}`,
    };
  }

  return {
    match: 'over',
    suggestedUnits: 1,
    covers: serves,
    surplus: serves - party,
    note: `ración de ${serves} (más grande que la mesa)`,
  };
};

const compareRanked = <T extends RankableDish>(
  a: RankedDishForParty<T>,
  b: RankedDishForParty<T>
): number => {
  const mr = MATCH_RANK[a.match] - MATCH_RANK[b.match];
  if (mr !== 0) return mr;
  if (a.match === 'near' || a.match === 'over') {
    const s = a.surplus - b.surplus;
    if (s !== 0) return s;
  }
  if (a.match === 'cover') {
    const u = a.suggestedUnits - b.suggestedUnits;
    if (u !== 0) return u;
    const s = a.surplus - b.surplus;
    if (s !== 0) return s;
  }
  const feat = Number(Boolean(b.is_featured)) - Number(Boolean(a.is_featured));
  if (feat !== 0) return feat;
  return a.name.localeCompare(b.name, 'es');
};

/**
 * Exact + near primero. Si no hay ninguno, cover (platos más chicos × unidades).
 * `over` solo si no hay exact/near/cover.
 */
export const rankDishesForReservationPartySize = <T extends RankableDish>(
  items: T[],
  partySize: number,
  limit: number
): RankedDishForParty<T>[] => {
  const safeLimit = Math.max(1, limit);
  const ranked: RankedDishForParty<T>[] = [];
  for (const item of items) {
    const serves = item.serves_people;
    if (typeof serves !== 'number' || !Number.isFinite(serves) || serves < 1) {
      continue;
    }
    ranked.push({ ...item, ...classifyDishForPartySize(serves, partySize) });
  }
  ranked.sort(compareRanked);

  const exactNear = ranked.filter((d) => d.match === 'exact' || d.match === 'near');
  if (exactNear.length > 0) return exactNear.slice(0, safeLimit);

  const cover = ranked.filter((d) => d.match === 'cover');
  if (cover.length > 0) return cover.slice(0, safeLimit);

  return ranked.filter((d) => d.match === 'over').slice(0, safeLimit);
};

export const instructionForDishPartyRanking = (params: {
  count: number;
  bestMatch: DishPartyMatch | 'none';
}): string => {
  if (params.count === 0 || params.bestMatch === 'none') {
    return (
      'No hay platos con ración cargada. Decilo con claridad; ' +
      'ofrecé buscar un plato por nombre (search_products) o seguir la reserva. ' +
      'PROHIBIDO decir que no hay menú si no llamaste la tool.'
    );
  }
  const base =
    'Mencioná nombre + serves_people. No armes pedido ni present_product_cta; ' +
    'es dato para la mesa. El resume de reserva sigue después. ';
  if (params.bestMatch === 'cover') {
    return (
      base +
      'No hay ración exacta ni cercana a N. Estas cubren con más de una unidad: ' +
      'decí suggestedUnits + note (ej. "2 del que sirve 2"). No inventes cantidades.'
    );
  }
  if (params.bestMatch === 'over') {
    return (
      base +
      'Solo hay raciones más grandes que la mesa. Decilo (note) y no inventes un plato más chico.'
    );
  }
  if (params.bestMatch === 'near') {
    return base + 'Ración un poco mayor que N: mencioná serves_people y que sobra.';
  }
  return base + 'Priorizá match=exact; si listás near, aclará la ración.';
};
