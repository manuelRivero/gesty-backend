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
  /** Copy al cliente: mismo dato que el shortlist de pedido (`ración para: N`). */
  note: string;
};

/** Misma meta que `formatSelectListCandidateMeta` (pedido). */
export const formatDishPartyRationNote = (servesPeople: number): string =>
  `ración para: ${Math.floor(servesPeople)}`;

/** Viñeta al cliente: `• *Nombre*` + línea de ración (pedido). */
export const formatDishPartyDisplayLine = (
  name: string,
  servesPeople: number
): string => `• *${name.trim()}*\n${formatDishPartyRationNote(servesPeople)}`;

export type RankedDishForParty<T extends RankableDish> = T &
  DishPartyRankFields & { displayLine: string };

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

  const note = formatDishPartyRationNote(serves);

  if (serves === party) {
    return {
      match: 'exact',
      suggestedUnits: 1,
      covers: serves,
      surplus: 0,
      note,
    };
  }

  if (serves > party && serves <= party + DISH_PARTY_NEAR_MAX_EXTRA) {
    return {
      match: 'near',
      suggestedUnits: 1,
      covers: serves,
      surplus: serves - party,
      note,
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
      note,
    };
  }

  return {
    match: 'over',
    suggestedUnits: 1,
    covers: serves,
    surplus: serves - party,
    note,
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
    const fields = classifyDishForPartySize(serves, partySize);
    ranked.push({
      ...item,
      ...fields,
      displayLine: formatDishPartyDisplayLine(item.name, serves),
    });
  }
  ranked.sort(compareRanked);

  const exactNear = ranked.filter((d) => d.match === 'exact' || d.match === 'near');
  if (exactNear.length > 0) return exactNear.slice(0, safeLimit);

  const cover = ranked.filter((d) => d.match === 'cover');
  if (cover.length > 0) return cover.slice(0, safeLimit);

  return ranked.filter((d) => d.match === 'over').slice(0, safeLimit);
};

/**
 * `reservationActive`: el turno es FAQ mid-reserva y el nodo anexa la única
 * pregunta del mensaje ("¿Seguimos con la reserva o preferís cancelarla?").
 * Ahí el texto del modelo termina en el dato del menú: ni cierre propio
 * (salía "¿Te gustaría seguir con la reserva...?" duplicando la anexada) ni
 * la frase de unidades del mundo pedido (la reserva guarda la mesa, no platos).
 */
export const instructionForDishPartyRanking = (params: {
  count: number;
  bestMatch: DishPartyMatch | 'none';
  reservationActive: boolean;
}): string => {
  const closing = params.reservationActive
    ? 'CIERRE: terminá en el dato del menú. PROHIBIDO cerrar con una pregunta o una oferta ' +
      '("¿seguimos con la reserva?", "¿algo más?", "¿te gustaría...?"): el sistema anexa la ' +
      'única pregunta del turno. '
    : '';

  if (params.count === 0 || params.bestMatch === 'none') {
    return (
      'No hay platos con ración cargada. Decilo con claridad; ' +
      (params.reservationActive
        ? ''
        : 'ofrecé buscar un plato por nombre (search_products) o seguir la reserva. ') +
      'PROHIBIDO decir que no hay menú si no llamaste la tool. ' +
      closing
    ).trim();
  }
  const base =
    'Listá cada ítem con displayLine TAL CUAL (mismo formato que pedido: ' +
    '• *Nombre* y debajo "ración para: N"). ' +
    'PROHIBIDO copiar suggestedUnits, covers, "3×", "cubre" o fórmulas al cliente. ' +
    'No armes pedido ni present_product_cta. ' +
    'PROHIBIDO ofrecer "agregar alguno a la reserva": la reserva guarda la mesa, no platos. ' +
    'PROHIBIDO pedir fecha, horario o "día y hora"; el sistema anexa solo seguir/cancelar. ' +
    closing;
  if (params.bestMatch === 'cover') {
    if (params.reservationActive) {
      return (
        base +
        'No hay ración exacta de N: son raciones más chicas. PROHIBIDO agregar la frase de ' +
        'unidades ("para N podés llevar más de una unidad") — en reserva no se llevan unidades. ' +
        'Tampoco pongas cantidades por renglón.'
      );
    }
    return (
      base +
      'No hay ración exacta de N. Después de la lista, UNA frase como en pedido: ' +
      'son ración individual / más chica; para N podés llevar más de una unidad. ' +
      'No pongas cantidades por renglón.'
    );
  }
  if (params.bestMatch === 'over') {
    return (
      base +
      'Solo hay raciones más grandes que la mesa. Después de la lista, UNA frase' +
      (params.reservationActive ? ' (dato, sin pregunta)' : '') +
      '; no inventes un plato más chico.'
    );
  }
  return base;
};
