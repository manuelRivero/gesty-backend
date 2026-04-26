import { EnrichedContext, HandlerResult, IntentHandler } from '../types';
import { textResponse } from '../utils';
import { ConversationIntent } from '../../../types/conversationIntent';
import { MenuService } from '../../../services/menu.service';

const formatPrice = (amount: unknown, currency: string | null | undefined): string => {
  if (amount == null || !currency) return 'precio no disponible';
  return `${String(amount)} ${currency}`;
};

export class RecommendationRequestHandler implements IntentHandler {
  readonly command = ConversationIntent.RECOMMENDATION_REQUEST;

  canHandle(intent: string): boolean {
    return intent === this.command;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    const currency =
      ctx.customer?.preferred_currency ?? ctx.business?.currency_code ?? null;
    const featured = await MenuService.getFeaturedMenuItems({
      businessId: ctx.business.id,
      currencyCode: currency,
      limit: 5,
    });

    if (featured.length === 0) {
      return textResponse(
        'Todavía no tenemos destacados cargados. Si querés, te muestro el menú y te ayudo a elegir según lo que te guste.'
      );
    }

    const lines = featured.map((item, idx) => {
      const activePrice = item.menu_item_price[0];
      const priceText = formatPrice(
        activePrice?.amount,
        activePrice?.currency_code
      );
      return `${idx + 1}. ${item.name} (${priceText})`;
    });

    return textResponse(
      `Te recomiendo estos destacados de la casa:\n${lines.join(
        '\n'
      )}\n\nDecime cuál te interesa y te paso más detalles.`
    );
  }
}
