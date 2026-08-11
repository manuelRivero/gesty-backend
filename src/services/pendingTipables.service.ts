/**
 * Tipables ofrecidos en el último mensaje interactivo (data para el agente).
 * No es un router regex: el híbrido razona contra este ledger + tools.
 */

import type { ConversationMetadata } from './productQuery/types';

export type TipableManagementAction =
  | 'VIEW_MENU'
  | 'VIEW_CART'
  | 'VIEW_CART_FOR_EDITION'
  | 'CHECKOUT'
  | 'ITEM_NOTE';

export type PendingTipables = {
  offeredAt: string;
  management?: TipableManagementAction[];
};

/** Gestión completa en listas de complemento post-add. */
export const COMPLEMENT_MANAGEMENT_TIPABLES: TipableManagementAction[] = [
  'VIEW_MENU',
  'VIEW_CART',
  'VIEW_CART_FOR_EDITION',
  'CHECKOUT',
  'ITEM_NOTE',
];

/** Solo menú (materialize legacy sin filas de pedido). */
export const COMPLEMENT_MENU_ONLY_TIPABLES: TipableManagementAction[] = [
  'VIEW_MENU',
];

/** Follow-up de gestión de carrito (sin Ver pedido tipable en body, sí modificar/finalizar/nota). */
export const CART_FOLLOWUP_MANAGEMENT_TIPABLES: TipableManagementAction[] = [
  'VIEW_MENU',
  'VIEW_CART_FOR_EDITION',
  'CHECKOUT',
  'ITEM_NOTE',
];

export function buildPendingTipablesPatch(
  management: TipableManagementAction[]
): Pick<ConversationMetadata, 'pendingTipables'> {
  const unique = [...new Set(management)];
  return {
    pendingTipables: {
      offeredAt: new Date().toISOString(),
      ...(unique.length > 0 ? { management: unique } : {}),
    },
  };
}

export const PENDING_TIPABLES_KEY = 'pendingTipables' as const;

export const MANAGEMENT_TOOL_HINT: Record<TipableManagementAction, string> = {
  VIEW_MENU:
    'present_product_cta(primaryKind="VIEW_MENU") o flujo de menú equivalente',
  VIEW_CART: 'present_cart()',
  VIEW_CART_FOR_EDITION:
    'present_cart() orientado a edición / indicar modificar pedido',
  CHECKOUT:
    'start_checkout_session(reason) si hay ítems (o indicar finalizar)',
  ITEM_NOTE:
    'get_cart → update_item_note(productId, note) en el mismo turno si el mensaje trae plato+nota',
};
