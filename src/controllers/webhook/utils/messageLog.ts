import type { WebhookContext } from '../types';

/**
 * Convierte el mensaje crudo del webhook al string que guardamos en el historial
 * (`conversation_message`): cuerpo de texto, marcador `[interactive: id]` para
 * respuestas de botón/lista, `[location]` u otros tipos como `[nombreTipo]`.
 *
 * Migrado 1:1 desde `src/controllers/webhook/orchestrator.ts` del backend.
 */
export function formatInboundMessageForLog(
  message: WebhookContext['message'] | undefined
): string {
  if (!message) {
    return '[unknown]';
  }
  if (message.type === 'text') {
    return message.text?.body || '';
  }
  if (message.type === 'interactive') {
    const buttonReply = message.interactive?.button_reply;
    const listReply = message.interactive?.list_reply;
    const selectedId = buttonReply?.id || listReply?.id || 'unknown';
    const selectedTitle = buttonReply?.title || listReply?.title || null;
    const readableAction = humanizeInteractivePayloadId(selectedId);

    if (selectedTitle && selectedTitle.trim().length > 0) {
      return `Selecciono opcion: ${selectedTitle} - ${readableAction} (${selectedId})`;
    }
    return `Selecciono opcion: ${readableAction} (${selectedId})`;
  }
  if (message.type === 'location') {
    return '[location]';
  }
  return `[${message.type || 'unknown'}]`;
}

export function humanizeInteractivePayloadId(payloadId: string): string {
  const staticLabels: Record<string, string> = {
    VIEW_MENU: 'Ver menu',
    VIEW_MENU_RETURN: 'Volver al menu',
    VIEW_CART: 'Ver carrito',
    VIEW_ORDER: 'Ver pedido',
    CHECKOUT: 'Finalizar pedido',
    CANCEL_ORDER: 'Cancelar pedido',
    'CANCEL_TARGET:draft': 'Cancelar carrito',
    'CANCEL_TARGET:order': 'Cancelar pedido creado',
    END_CONVERSATION: 'Terminar conversacion',
    ASK_QUESTION: 'Hacer una pregunta',
    RESERVATION_CONFIRM: 'Confirmar reserva',
    RESERVATION_CANCEL: 'Cancelar reserva',
  };

  if (staticLabels[payloadId]) {
    return staticLabels[payloadId];
  }

  const prefixLabels: Array<{ prefix: string; label: string }> = [
    { prefix: 'RESERVATION_SLOT:', label: 'Seleccion de horario de reserva' },
    { prefix: 'RESERVATION_ENV:', label: 'Seleccion de ambiente de reserva' },
    { prefix: 'CATEGORY_LIST_PAGE:', label: 'Navegacion de pagina de categorias' },
    { prefix: 'CATEGORY_PAGE:', label: 'Navegacion de pagina de platillos' },
    { prefix: 'CATEGORY:', label: 'Seleccion de categoria' },
    { prefix: 'SELECT_PRODUCT:', label: 'Seleccion de producto' },
    { prefix: 'SELECT_ORDER_PRODUCT:', label: 'Seleccion de producto para pedido' },
    { prefix: 'ORDER_SEARCH_PAGE:', label: 'Navegacion de busqueda de productos' },
    { prefix: 'ADD_ITEM:', label: 'Agregar producto al pedido' },
    { prefix: 'INCREASE_ITEM:', label: 'Aumentar cantidad del producto' },
    { prefix: 'DECREASE_ITEM:', label: 'Disminuir cantidad del producto' },
    { prefix: 'CONFIRM_INTENT:', label: 'Confirmacion de intencion' },
    { prefix: 'ONBOARDING_', label: 'Flujo de onboarding de direccion' },
  ];

  const matched = prefixLabels.find((item) => payloadId.startsWith(item.prefix));
  if (matched) {
    return matched.label;
  }

  return 'Opcion interactiva';
}
