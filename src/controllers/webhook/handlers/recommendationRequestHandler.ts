import { EnrichedContext, HandlerResult, IntentHandler } from '../types';
import { listResponse, textResponse } from '../utils';
import { ConversationIntent } from '../../../types/conversationIntent';
import { MenuService } from '../../../services/menu.service';
import { buildListMessageFromButtons, truncateDescription, truncateTitle } from '../../../whatsappBuilders';

const FEATURED_PAGE_SIZE = 8;

const buildFeaturedListMessage = async (
  ctx: EnrichedContext,
  page: number
) => {
  const currency =
    ctx.customer?.preferred_currency ?? ctx.business?.currency_code ?? null;
  const featuredPage = await MenuService.getFeaturedMenuItemsPage({
    businessId: ctx.business.id,
    currencyCode: currency,
    page,
    pageSize: FEATURED_PAGE_SIZE,
  });

  if (featuredPage.totalCount === 0) return null;

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

  return buildListMessageFromButtons(
    `🤖\n\nTe comparto nuestros productos destacados (página ${featuredPage.page}/${featuredPage.totalPages}). Elegí uno para ver foto, info y opciones para agregar al carrito 👇`,
    rows,
    'Ver destacados',
    '',
    'Seleccioná una opción'
  );
};

export class RecommendationRequestHandler implements IntentHandler {
  readonly command = ConversationIntent.RECOMMENDATION_REQUEST;

  canHandle(intent: string): boolean {
    return intent === this.command;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    const listMessage = await buildFeaturedListMessage(ctx, 1);
    if (!listMessage) {
      return textResponse(
        'Todavía no tenemos destacados cargados. Si querés, te muestro el menú y te ayudo a elegir según lo que te guste.'
      );
    }
    return listResponse(listMessage);
  }
}
