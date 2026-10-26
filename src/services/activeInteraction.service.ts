/**
 * activeInteraction — vigencia de interacciones de WhatsApp (listas/botones).
 *
 * Generaliza, para los payloads que NO están ya cubiertos por
 * `productResolution.service.ts` (ADD_ITEM/SELECT_PRODUCT/SELECT_ORDER_PRODUCT)
 * ni por la navegación global (VIEW_MENU, VIEW_CART, etc.), el mismo patrón
 * que ya usaba `whatsapp.service.ts` para `pendingProductSelection` +
 * `candidateProductIds`: un registro de "qué opciones siguen vigentes" en
 * `conversation_state.metadata`, que se reemplaza en cada envío interactivo y
 * se consume (como máximo una vez) al recibir la selección correspondiente.
 *
 * No reemplaza las validaciones de dominio existentes (p. ej. que un slot de
 * reserva siga activo en la DB, o que un ítem siga en el carrito): es una capa
 * previa que rechaza el click de una interacción vieja ANTES de llegar a esas
 * validaciones.
 *
 * Único punto de escritura: `sendResponseNode` (tras armar la respuesta del
 * turno). Único punto de lectura/consumo: `buildDetectionContextNode` (antes
 * de decidir a qué subflujo rutear el turno). Ver AUDITORIA-VIGENCIA-INTERACCIONES
 * para el resto de alternativas descartadas.
 */

import { randomUUID } from 'node:crypto';
import { mutateConversationMetadata } from '../repositories';

export const ACTIVE_INTERACTION_METADATA_KEY = 'activeInteraction' as const;

export interface ActiveInteraction {
  id: string;
  turnId?: string;
  validOptionIds: string[];
  createdAt: string;
  consumedOptionId?: string | null;
  consumedAt?: string | null;
}

/**
 * Botones/filas de navegación global: se muestran una y otra vez a lo largo
 * de la conversación y son idempotentes (ver el mismo carrito, volver al
 * menú, etc.). Quedan fuera de la vigencia por turno — igual que hoy.
 */
const ALWAYS_VALID_PAYLOAD_IDS = new Set<string>([
  'VIEW_MENU',
  'VIEW_MENU_RETURN',
  'VIEW_CART',
  'VIEW_ORDER',
  'CHECKOUT',
  'CANCEL_ORDER',
  'END_CONVERSATION',
  'ASK_QUESTION',
  'ORDER_FOOD',
  'VIEW_RESERVATION',
  'SUPPORT',
]);

/**
 * Prefijos ya gobernados por `productResolution.service.ts` (TTL propio,
 * consumo atómico, invalidación por turno/oferta). No se duplica esa lógica
 * acá para no tener dos mecanismos compitiendo sobre el mismo payload.
 */
const PRODUCT_GOVERNED_PREFIXES = ['ADD_ITEM:', 'SELECT_PRODUCT:', 'SELECT_ORDER_PRODUCT:'];

const isAlwaysValidPayloadId = (payloadId: string): boolean =>
  ALWAYS_VALID_PAYLOAD_IDS.has(payloadId);

const isProductGovernedPayloadId = (payloadId: string): boolean =>
  PRODUCT_GOVERNED_PREFIXES.some((prefix) => payloadId.startsWith(prefix));

/** true si este payload debe pasar por la vigencia genérica de `activeInteraction`. */
export const isGenericGatedPayloadId = (payloadId: string): boolean =>
  !isAlwaysValidPayloadId(payloadId) && !isProductGovernedPayloadId(payloadId);

const asMetadataRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readActiveInteraction = (metadata: Record<string, unknown>): ActiveInteraction | null => {
  const raw = metadata[ACTIVE_INTERACTION_METADATA_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || !Array.isArray(candidate.validOptionIds)) return null;
  return {
    id: candidate.id,
    turnId: typeof candidate.turnId === 'string' ? candidate.turnId : undefined,
    validOptionIds: candidate.validOptionIds.filter((id): id is string => typeof id === 'string'),
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date(0).toISOString(),
    consumedOptionId:
      typeof candidate.consumedOptionId === 'string' ? candidate.consumedOptionId : null,
    consumedAt: typeof candidate.consumedAt === 'string' ? candidate.consumedAt : null,
  };
};

/**
 * Registra (o reemplaza) la interacción activa de la conversación a partir
 * de los option ids del mensaje interactivo recién enviado. Se llama una vez
 * por turno, solo cuando el turno mandó un mensaje interactivo (lista o
 * botones) — un turno de puro texto no toca `activeInteraction`.
 *
 * Reemplaza siempre: un mensaje interactivo nuevo vuelve obsoleta cualquier
 * interacción anterior, aunque el nuevo mensaje no tenga ids gateados (en ese
 * caso queda sin interacción activa, no bloqueando nada).
 */
export const registerActiveInteraction = async (
  conversationId: string,
  rawOptionIds: string[],
  turnId?: string
): Promise<void> => {
  const gatedIds = [...new Set(rawOptionIds.filter(isGenericGatedPayloadId))];
  await mutateConversationMetadata(conversationId, (current) => {
    const next: ActiveInteraction | null =
      gatedIds.length === 0
        ? null
        : {
            id: randomUUID(),
            turnId,
            validOptionIds: gatedIds,
            createdAt: new Date().toISOString(),
            consumedOptionId: null,
            consumedAt: null,
          };
    return {
      metadata: { ...current, [ACTIVE_INTERACTION_METADATA_KEY]: next },
      result: undefined,
    };
  });
};

export type ActiveInteractionOutcome = 'none' | 'bypass' | 'valid' | 'stale' | 'invalidated';

/**
 * Evalúa (y, atómicamente, consume o invalida) la interacción activa contra
 * el mensaje entrante. Usa `mutateConversationMetadata`, que toma
 * `SELECT ... FOR UPDATE` sobre la fila de `conversation_state`: dos webhooks
 * concurrentes para la misma conversación (doble click, reintento) se
 * serializan sobre esa misma fila, así que el `consumedOptionId` solo puede
 * fijarse una vez — la segunda ejecución concurrente siempre ve el estado ya
 * consumido y recibe `stale`.
 *
 * - `none`: no hay interacción activa registrada — no hay nada que validar.
 * - `bypass`: el payload es de navegación global o está gobernado por
 *   `productResolution.service.ts` — no se toca `activeInteraction`.
 * - `valid`: el payload pertenece a la interacción activa y no estaba
 *   consumido — se marca consumido y el turno puede despachar la acción.
 * - `stale`: el payload parecía una selección pero no es la vigente (lista
 *   vieja) o ya se había consumido (doble click) — no debe ejecutarse nada.
 * - `invalidated`: llegó un mensaje nuevo que no es una selección de la
 *   interacción activa (texto libre, u otro payload) — se limpia
 *   `activeInteraction` y el turno sigue su curso normal.
 */
export const evaluateIncomingInteraction = async (
  conversationId: string,
  incoming: { isInteractivePayload: boolean; payloadId?: string | null }
): Promise<ActiveInteractionOutcome> => {
  return mutateConversationMetadata<ActiveInteractionOutcome>(conversationId, (current) => {
    const metadata = asMetadataRecord(current);
    const active = readActiveInteraction(metadata);
    if (!active) {
      return { metadata: null, result: 'none' };
    }

    const payloadId = incoming.payloadId ?? null;
    const isSelectionAttempt = incoming.isInteractivePayload && typeof payloadId === 'string';

    if (isSelectionAttempt && !isGenericGatedPayloadId(payloadId as string)) {
      return { metadata: null, result: 'bypass' };
    }

    if (isSelectionAttempt && active.validOptionIds.includes(payloadId as string)) {
      if (active.consumedOptionId) {
        return { metadata: null, result: 'stale' };
      }
      const consumed: ActiveInteraction = {
        ...active,
        consumedOptionId: payloadId as string,
        consumedAt: new Date().toISOString(),
      };
      return {
        metadata: { ...metadata, [ACTIVE_INTERACTION_METADATA_KEY]: consumed },
        result: 'valid',
      };
    }

    // Selección de una interacción distinta a la vigente, o mensaje nuevo
    // (texto/otro tipo) que no corresponde a la interacción activa: en
    // cualquier caso, la interacción vieja queda obsoleta.
    return {
      metadata: { ...metadata, [ACTIVE_INTERACTION_METADATA_KEY]: null },
      result: isSelectionAttempt ? 'stale' : 'invalidated',
    };
  });
};
