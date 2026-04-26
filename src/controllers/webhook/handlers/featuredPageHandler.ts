import { EnrichedContext, HandlerResult, IntentHandler } from '../types';
import { listResponse, parsePageOnly, textResponse } from '../utils';
import { ConversationIntent } from '../../../types/conversationIntent';
import { MenuService } from '../../../services/menu.service';
import {
  buildListMessageFromButtons,
  truncateDescription,
  truncateTitle,
} from '../../../whatsappBuilders';
import { formatBotUserMessage } from '../../../services/productQuery/utils';

const FEATURED_PAGE_SIZE = 8;

export class FeaturedPageHandler implements IntentHandler {
  readonly command = ConversationIntent.FEATURED_PAGE;

  canHandle(intent: string): boolean {
    return intent === this.command;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    const page = parsePageOnly(ctx.payloadId ?? '');
    const currency =
      ctx.customer?.preferred_currency ?? ctx.business?.currency_code ?? null;
    const featuredPage = await MenuService.getFeaturedMenuItemsPage({
      businessId: ctx.business.id,
      currencyCode: currency,
      page,
      pageSize: FEATURED_PAGE_SIZE,
    });

    if (featuredPage.totalCount === 0) {
      return textResponse(
        formatBotUserMessage(
          'Recomendaciones',
          '🍽️',
          'Por ahora no hay destacados disponibles. Si querés, te muestro el menú completo.'
        )
      );
    }

    const rows = featuredPage.items.map((item) => {
      const activePrice = item.menu_item_price[0];
      const priceText =
        activePrice?.amount != null && activePrice.currency_code
          ? `${activePrice.amount.toString()} ${activePrice.currency_code}`
          : 'Precio no disponible';
      return {
        title: truncateTitle(item.name || 'Producto'),
        payload: `SELECT_PRODUCT:${item.id}`,
        description: truncateDescription(priceText, 60),
        sectionTitle: 'Destacados',
      };
    });

    if (featuredPage.page < featuredPage.totalPages) {
      rows.push({
        title: 'Ver más destacados',
        payload: `FEATURED_PAGE:${featuredPage.page + 1}`,
        description: `Página ${featuredPage.page + 1} de ${featuredPage.totalPages}`,
        sectionTitle: 'Navegación',
      });
    }

    rows.push({
      title: 'Ver menú completo',
      payload: 'VIEW_MENU',
      description: 'Explorar todas las categorías',
      sectionTitle: 'Navegación',
    });

    const listMessage = buildListMessageFromButtons(
      formatBotUserMessage(
        'Recomendaciones para vos',
        '🍽️',
        `Productos destacados (página ${featuredPage.page}/${featuredPage.totalPages}). Elegí uno para ver foto, detalles y poder agregarlo al carrito 👇`
      ),
      rows,
      'Ver destacados',
      '',
      'Seleccioná una opción'
    );

    return listResponse(listMessage);
  }
}
