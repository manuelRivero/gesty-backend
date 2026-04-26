import type { WhatsAppInteractiveMessage } from '../domain/intent/whatsappTemplates';
import { ConversationIntent } from '../types/conversationIntent';

const BTN_MAX = 20;

function truncateButtonTitle(title: string): string {
  if (title.length <= BTN_MAX) return title;
  return title.slice(0, BTN_MAX);
}

/** Etiqueta corta para botones y cuerpo del mensaje de confirmación. */
export function intentConfirmationShortLabel(
  intent: ConversationIntent
): string {
  const map: Partial<Record<ConversationIntent, string>> = {
    [ConversationIntent.ORDER_FOOD]: 'hacer un pedido',
    [ConversationIntent.VIEW_CART]: 'ver tu carrito',
    [ConversationIntent.VIEW_CART_FOR_EDITION]: 'modificar tu pedido',
    [ConversationIntent.PRODUCT_QUERY]: 'buscar en el menú',
    [ConversationIntent.RECOMMENDATION_REQUEST]: 'recibir recomendaciones',
    [ConversationIntent.VIEW_MENU]: 'ver el menú',
    [ConversationIntent.REMOVE_ITEM]: 'quitar algo del pedido',
    [ConversationIntent.MODIFY_QUANTITY]: 'cambiar cantidades',
    [ConversationIntent.SMALL_TALK]: 'saludar',
    [ConversationIntent.ASK_QUESTION]: 'hacer una consulta',
    [ConversationIntent.BUSINESS_HOURS]: 'ver horarios',
    [ConversationIntent.EDIT_ADDRESS]: 'cambiar la dirección',
    [ConversationIntent.RESERVATION]: 'reservar mesa',
    [ConversationIntent.CHECKOUT]: 'finalizar la compra',
  };
  return map[intent] ?? intent.replace(/_/g, ' ').toLowerCase();
}

export function intentConfirmationButtonTitle(intent: ConversationIntent): string {
  const map: Partial<Record<ConversationIntent, string>> = {
    [ConversationIntent.ORDER_FOOD]: 'Hacer un pedido',
    [ConversationIntent.VIEW_CART]: 'Ver mi carrito',
    [ConversationIntent.VIEW_CART_FOR_EDITION]: 'Modificar pedido',
    [ConversationIntent.PRODUCT_QUERY]: 'Buscar en el menú',
    [ConversationIntent.RECOMMENDATION_REQUEST]: 'Recomendaciones',
    [ConversationIntent.VIEW_MENU]: 'Ver menú',
    [ConversationIntent.REMOVE_ITEM]: 'Quitar del pedido',
    [ConversationIntent.MODIFY_QUANTITY]: 'Cambiar cantidad',
    [ConversationIntent.SMALL_TALK]: 'Saludo',
    [ConversationIntent.ASK_QUESTION]: 'Una consulta',
    [ConversationIntent.BUSINESS_HOURS]: 'Horarios',
    [ConversationIntent.EDIT_ADDRESS]: 'Editar dirección',
    [ConversationIntent.RESERVATION]: 'Reservar',
    [ConversationIntent.CHECKOUT]: 'Finalizar',
  };
  return truncateButtonTitle(map[intent] ?? intent.replace(/_/g, ' ').slice(0, BTN_MAX));
}

/**
 * Dos botones `CONFIRM_INTENT:<intent>` para desambiguar sin volver a llamar al modelo.
 */
export function buildIntentAmbiguityInteractiveMessage(
  candidates: Array<{ intent: ConversationIntent; confidence: number }>
): WhatsAppInteractiveMessage {
  const [a, b] = candidates;
  const labelA = intentConfirmationShortLabel(a.intent);
  const labelB = intentConfirmationShortLabel(b.intent);
  const body = `¿Querías *${labelA}* o *${labelB}*? 👇`;

  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '' },
      body: { text: body },
      footer: { text: 'Elegí una opción' },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: {
              id: `CONFIRM_INTENT:${a.intent}`,
              title: intentConfirmationButtonTitle(a.intent),
            },
          },
          {
            type: 'reply',
            reply: {
              id: `CONFIRM_INTENT:${b.intent}`,
              title: intentConfirmationButtonTitle(b.intent),
            },
          },
        ],
      },
    },
  };
}
