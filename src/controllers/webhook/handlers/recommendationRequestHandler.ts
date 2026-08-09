import { EnrichedContext, HandlerResult, IntentHandler } from '../types';
import { listResponse, textResponse } from '../utils';
import { ConversationIntent } from '../../../types/conversationIntent';
import { MenuService } from '../../../services/menu.service';
import { getPopularMenuItems } from '../../../services/popularProducts.service';
import { buildListMessageFromButtons, truncateDescription, truncateTitle } from '../../../whatsappBuilders';
import { formatBotUserMessage } from '../../../services/productQuery/utils';

const FEATURED_PAGE_SIZE = 8;

type ListRow = {
  title: string;
  payload: string;
  description: string;
  sectionTitle: string;
};

const buildRowsFromItems = (
  items: Array<{ id: string; name: string; priceText: string }>,
  sectionTitle: string
): ListRow[] =>
  items.map((item) => ({
    title: truncateTitle(item.name || 'Producto'),
    payload: `SELECT_PRODUCT:${item.id}`,
    description: truncateDescription(item.priceText, 60),
    sectionTitle,
  }));

const appendNavRows = (
  rows: ListRow[],
  opts?: { moreFeatured?: { nextPage: number; totalPages: number } }
): ListRow[] => {
  const next = [...rows];
  if (opts?.moreFeatured) {
    next.push({
      title: 'Ver más destacados',
      payload: `FEATURED_PAGE:${opts.moreFeatured.nextPage}`,
      description: `Página ${opts.moreFeatured.nextPage} de ${opts.moreFeatured.totalPages}`,
      sectionTitle: 'Navegación',
    });
  }
  next.push({
    title: 'Ver menú completo',
    payload: 'VIEW_MENU',
    description: 'Explorar todas las categorías',
    sectionTitle: 'Navegación',
  });
  return next;
};

const buildFeaturedListMessage = async (ctx: EnrichedContext, page: number) => {
  const currency =
    ctx.customer?.preferred_currency ?? ctx.business?.currency_code ?? null;
  const featuredPage = await MenuService.getFeaturedMenuItemsPage({
    businessId: ctx.business.id,
    currencyCode: currency,
    page,
    pageSize: FEATURED_PAGE_SIZE,
  });

  if (featuredPage.totalCount === 0) return null;

  const itemRows = buildRowsFromItems(
    featuredPage.items.map((item) => {
      const activePrice = item.menu_item_price[0];
      const priceText =
        activePrice?.amount != null && activePrice.currency_code
          ? `${activePrice.amount.toString()} ${activePrice.currency_code}`
          : 'Precio no disponible';
      return { id: item.id, name: item.name || 'Producto', priceText };
    }),
    'Destacados'
  );

  const rows = appendNavRows(itemRows, {
    moreFeatured:
      featuredPage.page < featuredPage.totalPages
        ? { nextPage: featuredPage.page + 1, totalPages: featuredPage.totalPages }
        : undefined,
  });

  return buildListMessageFromButtons(
    formatBotUserMessage(
      'Recomendaciones para vos',
      '🍽️',
      `Te comparto nuestros productos destacados (página ${featuredPage.page}/${featuredPage.totalPages}). Elegí uno para ver foto, info y opciones para agregar al carrito 👇`
    ),
    rows,
    'Ver destacados',
    '',
    'Seleccioná una opción'
  );
};

const buildPopularListMessage = async (ctx: EnrichedContext) => {
  const currency =
    ctx.customer?.preferred_currency ?? ctx.business?.currency_code ?? null;
  const { significant, items } = await getPopularMenuItems({
    businessId: ctx.business.id,
    currencyCode: currency,
    limit: FEATURED_PAGE_SIZE,
  });

  if (!significant || items.length === 0) return null;

  const itemRows = buildRowsFromItems(
    items.map((item) => {
      const firstPrice = item.prices[0];
      const priceText = firstPrice
        ? `${firstPrice.amount} ${firstPrice.currency}`
        : 'Precio no disponible';
      return { id: item.id, name: item.name, priceText };
    }),
    'Los más pedidos'
  );

  const rows = appendNavRows(itemRows);

  return buildListMessageFromButtons(
    formatBotUserMessage(
      'Los más pedidos',
      '🍽️',
      'Estos son los platos que más pide la gente. Elegí uno para ver foto, info y opciones para agregar al carrito 👇'
    ),
    rows,
    'Ver más pedidos',
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
    // Cadena D9: destacados → popularidad significativa → mensaje vacío actual.
    const featured = await buildFeaturedListMessage(ctx, 1);
    if (featured) return listResponse(featured);

    const popular = await buildPopularListMessage(ctx);
    if (popular) return listResponse(popular);

    return textResponse(
      formatBotUserMessage(
        'Recomendaciones',
        '🍽️',
        'Todavía no tenemos destacados cargados. Si querés, te muestro el menú y te ayudo a elegir según lo que te guste.'
      )
    );
  }
}
