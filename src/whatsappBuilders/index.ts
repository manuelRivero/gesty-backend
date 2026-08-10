import { WhatsAppListMessage } from "../domain/intent/whatsappTemplates";

const buildListMessage = (params: {
    headerText: string;
    bodyText: string;
    footerText: string;
    actionButtonLabel: string;
    sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>;
  }): WhatsAppListMessage => ({
    type: 'list',
    header: { type: 'text', text: params.headerText },
    body: { text: params.bodyText },
    footer: { text: params.footerText },
    action: {
      button: params.actionButtonLabel,
      sections: params.sections
    }
  });
  
  export const buildListMessageFromButtons = (
    bodyText: string,
    buttons: { title: string; payload: string; description?: string; sectionTitle?: string }[],
    actionButtonLabel = 'Ver opciones',
    headerText = 'Opciones',
    footerText = 'Toca el botón de abajo para ver las opciones'
  ): WhatsAppListMessage => {
    const sections = new Map<string, Array<{ id: string; title: string; description?: string }>>();
    for (const button of buttons) {
      const sectionTitle = button.sectionTitle ?? 'Opciones';
      const rows = sections.get(sectionTitle) ?? [];
      rows.push({
        id: button.payload,
        title: button.title,
        ...(button.description ? { description: button.description } : {})
      });
      sections.set(sectionTitle, rows);
    }
  
    return buildListMessage({
      headerText,
      bodyText,
      footerText,
      actionButtonLabel,
      sections: Array.from(sections.entries()).map(([title, rows]) => ({
        title,
        rows
      }))
    });
  };
  
  export const buildOrderSearchListMessage = (params: {
    items: Array<{ id: string; name: string; description: string | null; ingredients: string | null }>;
    page: number;
  }): WhatsAppListMessage => {
    const pageSize = 8;
    const totalCount = params.items.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const safePage = Math.min(Math.max(params.page, 1), totalPages);
    const start = (safePage - 1) * pageSize;
    const end = start + pageSize;
    const pageItems = params.items.slice(start, end);
  
    console.log('---- MULTI MATCH PAGINATED ----');
    console.log('Page:', safePage);
    console.log('Total products:', totalCount);
    console.log('--------------------------------');
  
    const rows = pageItems.map((item) => ({
      id: `SELECT_ORDER_PRODUCT:${item.id}`,
      title: item.name,
      description: truncateDescription(item.description ?? item.ingredients ?? 'Sin descripción')
    }));
  
    if (safePage < totalPages) {
      rows.push({
        id: `ORDER_SEARCH_PAGE:${safePage + 1}`,
        title: '🔎 Ver más productos',
        description: 'Mostrar más resultados'
      });
    }
  
    rows.push({
      id: 'VIEW_MENU_RETURN',
      title: '📋 Ver todo el menú',
      description: 'Explorar categorías'
    });
  
    return buildListMessage({
      headerText: '🤖\n\n*Este es nuestro menú* 🍲',
      bodyText:
        'Elegí una opción de la lista, o escribí en texto libre:\n\n' +
        '• *Plato* — si ya sabés qué querés, escribí el nombre y te lo busco\n' +
        '• *Menú completo* — explorá todas las categorías desde la lista',
      footerText: 'Elegí una opción',
      actionButtonLabel: 'Ver menú',
      sections: [
        { title: 'Menú', rows }
      ]
    });
  };
  
  export const truncateDescription = (value: string, maxLength = 60): string =>
    value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
  export const truncateTitle = (value: string, maxLength = 24): string => value.slice(0, maxLength);