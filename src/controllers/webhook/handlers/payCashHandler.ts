import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { ConversationIntent } from '../../../types/conversationIntent';
import { textResponse, noResponse } from '../utils';
import { buildCashCheckoutResult } from '../../../services/checkout.service';
import { closeConversation } from '../../../repositories';
import { prisma } from '../../../lib/prisma';
import { getBusinessConfig } from '../../../services/businessConfig.service';

export class PayCashHandler implements IntentHandler {
  readonly command = ConversationIntent.PAY_CASH;

  canHandle(intent: string): boolean {
    return intent === ConversationIntent.PAY_CASH;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const business = (ctx as any).business;
    const customer = (ctx as any).customer;
    const conversation = (ctx as any).conversation;

    if (!business || !customer || !conversation) return noResponse();

    // Marcar el draft con payment_method=cash antes de crear la orden
    await prisma.draft_order.updateMany({
      where: {
        business_id: business.id,
        customer_phone: customer.phone_number,
        status: 'active',
      },
      data: { payment_method: 'cash' },
    });

    const businessConfig = await getBusinessConfig(business.id);
    const result = await buildCashCheckoutResult(business, conversation, customer, {
      externalDeliveryEnabled: businessConfig.external_delivery_enabled,
    });

    if (result.errorMessage) {
      return textResponse(result.errorMessage);
    }

    if (!result.message) {
      return noResponse();
    }

    return textResponse(result.message, result.followUps);
  }
}
