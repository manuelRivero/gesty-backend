import { ConversationIntent } from '../../types/conversationIntent';

// UNIFICADO: Todos los intents en orden lógico
export const INTENT_ENUM_VALUES = [
  // Botones interactivos (alta prioridad, acciones concretas)
  ConversationIntent.SELECT_PRODUCT,
  ConversationIntent.SELECT_ORDER_PRODUCT,
  ConversationIntent.ORDER_SEARCH_PAGE,
  ConversationIntent.CATEGORY_PAGE,
  ConversationIntent.CATEGORY_LIST_PAGE,
  ConversationIntent.MENU_BY_TAG,
  ConversationIntent.CATEGORY,
  ConversationIntent.SELECT_CART_ITEM,
  ConversationIntent.ADD_ITEM,
  ConversationIntent.COMPLEMENT_SHOW_SUGGESTIONS,
  ConversationIntent.CHECKOUT,
  ConversationIntent.PAY_ONLINE,
  ConversationIntent.PAY_CASH,
  ConversationIntent.CANCEL_ORDER,
  ConversationIntent.END_CONVERSATION,
  ConversationIntent.VIEW_MENU_RETURN,
  ConversationIntent.CONFIRM_REMOVE,
  ConversationIntent.CANCEL_REMOVE,
  ConversationIntent.INCREASE_ITEM_QUANTITY,
  ConversationIntent.CONFIRM_REMOVE,
  ConversationIntent.CANCEL_REMOVE,
  ConversationIntent.REMOVE_ITEM,
  ConversationIntent.DECREASE_ITEM_QUANTITY,
  ConversationIntent.SELECT_CART_ITEM,
  
  // Acciones de pedido por lenguaje natural
  ConversationIntent.ORDER_FOOD,
  ConversationIntent.ADD_PRODUCT,        // NUEVO
  ConversationIntent.REMOVE_ITEM,        // NUEVO
  ConversationIntent.MODIFY_QUANTITY,    // NUEVO
  
  // Consultas y navegación
  ConversationIntent.VIEW_MENU,
  ConversationIntent.VIEW_CART,
  ConversationIntent.PRODUCT_QUERY,
  ConversationIntent.PRODUCT_ATTRIBUTE_QUESTION,
  
  // Información del negocio
  ConversationIntent.PAYMENT_REQUEST,
  ConversationIntent.PAYMENT_METHODS,
  ConversationIntent.BUSINESS_HOURS,
  ConversationIntent.BUSINESS_LOCATION,
  ConversationIntent.DELIVERY_INFO,
  
  // Conversación general
  ConversationIntent.SUPPORT,
  ConversationIntent.GENERAL_QUESTION,
  ConversationIntent.SMALL_TALK,
  ConversationIntent.ASK_QUESTION,
  ConversationIntent.RESERVATION,
  
  ConversationIntent.UNKNOWN,
] as const;

export type IntentString = typeof INTENT_ENUM_VALUES[number];

// PRIORIDAD: Orden de precedencia (más específico = más prioritario)
export const INTENT_PRIORITY: ConversationIntent[] = [
  // 1. Botones (acciones concretas del usuario)
  ConversationIntent.REMOVE_ITEM,        // NUEVO - alta prioridad
  ConversationIntent.MODIFY_QUANTITY,  
  ConversationIntent.CONFIRM_REMOVE,
  ConversationIntent.CANCEL_REMOVE,
  ConversationIntent.SELECT_PRODUCT,
  ConversationIntent.SELECT_ORDER_PRODUCT,
  ConversationIntent.ADD_ITEM,
  ConversationIntent.COMPLEMENT_SHOW_SUGGESTIONS,
  ConversationIntent.CHECKOUT,
  ConversationIntent.PAY_ONLINE,
  ConversationIntent.PAY_CASH,
  ConversationIntent.CANCEL_ORDER,
  ConversationIntent.END_CONVERSATION,
  ConversationIntent.SELECT_CART_ITEM,
  ConversationIntent.INCREASE_ITEM_QUANTITY,
  ConversationIntent.DECREASE_ITEM_QUANTITY,
  
  // 2. Acciones de pedido (lenguaje natural específico)
  ConversationIntent.REMOVE_ITEM,        // NUEVO
  ConversationIntent.MODIFY_QUANTITY,  // NUEVO
  ConversationIntent.ADD_PRODUCT,        // NUEVO
  
  // 3. Navegación
  ConversationIntent.MENU_BY_TAG,
  ConversationIntent.CATEGORY,
  ConversationIntent.CATEGORY_PAGE,
  ConversationIntent.CATEGORY_LIST_PAGE,
  ConversationIntent.VIEW_MENU_RETURN,
  ConversationIntent.VIEW_CART,
  ConversationIntent.VIEW_CART_FOR_EDITION,
  ConversationIntent.ORDER_SEARCH_PAGE,
  
  // 4. Consultas de productos
  ConversationIntent.PRODUCT_QUERY,
  ConversationIntent.PRODUCT_ATTRIBUTE_QUESTION,
  ConversationIntent.ORDER_FOOD,
  
  // 5. Información y servicio
  ConversationIntent.TRACK_ORDER,
  ConversationIntent.PAYMENT_REQUEST,
  ConversationIntent.PAYMENT_METHODS,
  ConversationIntent.BUSINESS_HOURS,
  ConversationIntent.BUSINESS_LOCATION,
  ConversationIntent.DELIVERY_INFO,
  ConversationIntent.SUPPORT,
  
  // 6. Conversación general
  ConversationIntent.GENERAL_QUESTION,
  ConversationIntent.SMALL_TALK,
  ConversationIntent.ASK_QUESTION,
  ConversationIntent.RESERVATION,
  
  // 7. Fallback
  ConversationIntent.UNKNOWN
];

// Actualizar normalizeIntent
export const normalizeIntent = (value: string): ConversationIntent => {
  const trimmed = value.trim().toUpperCase();

  switch (trimmed) {
    // Botones
    case ConversationIntent.SELECT_PRODUCT:
    case ConversationIntent.SELECT_ORDER_PRODUCT:
    case ConversationIntent.ORDER_SEARCH_PAGE:
    case ConversationIntent.CATEGORY_PAGE:
    case ConversationIntent.CATEGORY_LIST_PAGE:
    case ConversationIntent.MENU_BY_TAG:
    case ConversationIntent.CATEGORY:
    case ConversationIntent.ADD_ITEM:
    case ConversationIntent.COMPLEMENT_SHOW_SUGGESTIONS:
    case ConversationIntent.CHECKOUT:
    case ConversationIntent.CANCEL_ORDER:
    case ConversationIntent.END_CONVERSATION:
    case ConversationIntent.VIEW_MENU_RETURN:
    case ConversationIntent.VIEW_MENU:
    case ConversationIntent.CONFIRM_REMOVE:
    case ConversationIntent.CANCEL_REMOVE:
    case ConversationIntent.SELECT_CART_ITEM:
    
    // Acciones de pedido (nuevas)
    case ConversationIntent.REMOVE_ITEM:
    case ConversationIntent.MODIFY_QUANTITY:
    case ConversationIntent.ADD_PRODUCT:
    
    // Originales
    case ConversationIntent.SMALL_TALK:
    case ConversationIntent.VIEW_CART:
    case ConversationIntent.VIEW_CART_FOR_EDITION:
    case ConversationIntent.ASK_QUESTION:
    case ConversationIntent.ORDER_FOOD:
    case ConversationIntent.TRACK_ORDER:
    case ConversationIntent.PAYMENT_REQUEST:
    case ConversationIntent.SUPPORT:
    case ConversationIntent.BUSINESS_HOURS:
    case ConversationIntent.BUSINESS_LOCATION:
    case ConversationIntent.DELIVERY_INFO:
    case ConversationIntent.PAYMENT_METHODS:
    case ConversationIntent.PRODUCT_QUERY:
    case ConversationIntent.PRODUCT_ATTRIBUTE_QUESTION:
    case ConversationIntent.GENERAL_QUESTION:
    case ConversationIntent.RESERVATION:
    case ConversationIntent.UNKNOWN:
    case ConversationIntent.PAY_ONLINE:
    case ConversationIntent.PAY_CASH:
      return trimmed as ConversationIntent;
    default:
      return ConversationIntent.UNKNOWN;
  }
};

// Funciones sin cambios
export const mapUnknownIntents = (intents: string[]): IntentString[] => {
  const allowed = new Set<string>(INTENT_ENUM_VALUES);
  return intents.map((intent) => {
    const trimmed = intent.trim().toUpperCase();
    return allowed.has(trimmed)
      ? (trimmed as IntentString)
      : ConversationIntent.UNKNOWN;
  });
};

export const selectHighestPriorityIntent = (
  intents: string[]
): ConversationIntent => {
  const normalized = intents.map((intent) => {
    const trimmed = intent.trim().toUpperCase();
    if (trimmed === 'BUSINESS_INFO') {
      return ConversationIntent.GENERAL_QUESTION;
    }
    return normalizeIntent(trimmed);
  });

  for (const candidate of INTENT_PRIORITY) {
    if (normalized.includes(candidate)) {
      return candidate;
    }
  }

  return ConversationIntent.UNKNOWN;
};
