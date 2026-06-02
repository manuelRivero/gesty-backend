
export interface WhatsAppListSection {
  title: string;
  rows: Array<{
    id: string;
    title: string;
    description?: string;
  }>;
}

export interface WhatsAppListMessage {
  type: 'list';
  header: {
    type: 'text';
    text: string;
  };
  body: {
    text: string;
  };
  footer: {
    text: string;
  };
  action: {
    button: string;
    sections: WhatsAppListSection[];
  };
}

export interface WhatsAppInteractiveMessage {
  type: 'interactive',
  interactive: {
    type: 'button',
    header: {
      type: 'text' | 'image',
      text?: string,
      image?: {
        link: string
      }
    },
    body: {
      text: string
    },
    footer: {
      text: string
    },
    action: {
      buttons: {
        type: 'reply',
        reply: {
          id: string,
          title: string
        }
      }[]
    }
  }
}

export const INTENT_SELECTION_ID_PREFIX = 'confirm_intent:';

export function createIntentConfirmationList(
  candidates: Array<{ intent: string; label: string; description: string }>
): WhatsAppListMessage {
  const rows = candidates.map((candidate) => ({
    id: `${INTENT_SELECTION_ID_PREFIX}${candidate.intent}`,
    title: candidate.label,
    description: candidate.description
  }));

  return {
    type: 'list',
    header: {
      type: 'text',
      text: '¿Qué necesitas? 🤔'
    },
    body: {
      text: 'No estoy seguro de entenderte bien. Por favor, selecciona una de estas opciones:'
    },
    footer: {
      text: 'Toca el botón de abajo para ver las opciones'
    },
    action: {
      button: 'Ver opciones disponibles',
      sections: [
        {
          title: 'Opciones sugeridas',
          rows: rows
        }
      ]
    }
  };
}

export const LIST_OPTION_LABELS: Record<
  string,
  { title: string; description: string }
> = {
  ORDER_FOOD: {
    title: 'Hacer un pedido 🍕',
    description: 'Ordenar comida para delivery o recoger'
  },
  VIEW_MENU: {
    title: 'Ver el menú completo 📖',
    description: 'Explorar todas nuestras categorías'
  },
  VIEW_ORDER: {
    title: 'Ver mi pedido actual 🛒',
    description: 'Revisar qué has ordenado hasta ahora'
  },
  TRACK_ORDER: {
    title: 'Seguimiento de pedido 🚚',
    description: 'Saber dónde está tu orden'
  },
  PRODUCT_QUERY: {
    title: 'Consultar un producto ❓',
    description: 'Preguntar sobre ingredientes, precios, etc.'
  },
  PAYMENT_REQUEST: {
    title: 'Información de pago 💳',
    description: 'Cómo pagar tu pedido'
  },
  BUSINESS_HOURS: {
    title: 'Horarios de atención 🕐',
    description: 'Cuándo estamos abiertos'
  },
  BUSINESS_LOCATION: {
    title: 'Ubicación del local 📍',
    description: 'Dónde encontrarnos'
  },
  DELIVERY_INFO: {
    title: 'Zonas de envío 🛵',
    description: 'Cobertura y tiempos de entrega'
  },
  PAYMENT_METHODS: {
    title: 'Métodos de pago 💰',
    description: 'Efectivo, tarjeta, transferencia'
  },
  SUPPORT: {
    title: 'Hablar con soporte 🎧',
    description: 'Atención personalizada'
  },
  GENERAL_QUESTION: {
    title: 'Otra consulta 🤔',
    description: 'Preguntas generales'
  },
  SMALL_TALK: {
    title: 'Solo saludar 👋',
    description: 'Iniciar una conversación'
  },
  UNKNOWN: {
    title: 'Otra opción ❓',
    description: 'Ninguna de las anteriores'
  }
};
