import {
  getGoalFulfillmentContract,
  getIntentCatalogEntry,
  type IntentCandidate,
} from '../domain/intent/family';
import { computeCatalogPermission, type IntentLedgerEntry } from './intent/activeIntent.service';
import {
  getNextOrderLineRequiringQuantity,
  getPendingOrderLines,
} from './pendingOrderLines.service';

export const ORDER_QUANTITY_GOAL_TYPE = 'OBTENER_CANTIDAD_DEL_PRODUCTO' as const;

export type OrderQuantityGoalFacts = {
  activePedir: boolean;
  checkoutActive: boolean;
  partySizeKnown: boolean;
  metadata: unknown;
  businessId?: string;
  conversationId?: string;
};

export const deriveOrderQuantityGoalTarget = (
  facts: OrderQuantityGoalFacts
) => {
  if (!facts.activePedir || facts.checkoutActive || !facts.partySizeKnown) return null;
  return getNextOrderLineRequiringQuantity(getPendingOrderLines(facts.metadata), {
    metadata: facts.metadata,
    businessId: facts.businessId,
    conversationId: facts.conversationId,
  });
};

export const deriveOrderQuantityGoalCandidate = (
  facts: OrderQuantityGoalFacts,
  ledgerEntry: IntentLedgerEntry | undefined,
  now: number = Date.now()
): IntentCandidate | null => {
  const target = deriveOrderQuantityGoalTarget(facts);
  if (!target) return null;
  const permission = computeCatalogPermission(ORDER_QUANTITY_GOAL_TYPE, ledgerEntry ?? {}, now);
  if (!permission.granted) return null;

  const catalog = getIntentCatalogEntry(ORDER_QUANTITY_GOAL_TYPE);
  const fulfillment = getGoalFulfillmentContract(ORDER_QUANTITY_GOAL_TYPE);
  if (!fulfillment) throw new Error(`Missing fulfillment contract for ${ORDER_QUANTITY_GOAL_TYPE}`);
  return {
    type: ORDER_QUANTITY_GOAL_TYPE,
    kind: catalog.kind,
    pressure: catalog.pressure,
    closeMode: catalog.closeMode,
    hint:
      `- Goal (OBTENER_CANTIDAD_DEL_PRODUCTO, blocking): falta la cantidad de la línea ` +
      `"${target.hint}" (orderLineId: ${target.id}). Preguntá cuántas unidades quiere. ` +
      `Una respuesta corta corresponde SOLO a esa línea. No la agregues hasta persistir ` +
      `la cantidad confirmada. No uses partySize ni suggestedQuantity como cantidad.`,
    fulfillment,
    tieBreak: 96,
  };
};
