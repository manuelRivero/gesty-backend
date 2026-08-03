import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { ConversationIntent } from '../../../types/conversationIntent';
import { textResponse, noResponse } from '../utils';
import { buildUnpaidCheckoutResult } from '../../../services/checkout.service';
import { prisma } from '../../../lib/prisma';
import { getBusinessConfig } from '../../../services/businessConfig.service';
import { getPaymentMethodInstructions } from '../../../services/paymentMethods.service';
import type { PaymentMethodId } from '../../../domain/payment/paymentMethods';

async function executeUnpaidMethod(
  ctx: WebhookContext,
  method: PaymentMethodId
): Promise<HandlerResult | null> {
  const business = (ctx as any).business;
  const customer = (ctx as any).customer;
  const conversation = (ctx as any).conversation;

  if (!business || !customer || !conversation) return noResponse();

  await prisma.draft_order.updateMany({
    where: {
      business_id: business.id,
      customer_phone: customer.phone_number,
      status: 'active',
    },
    data: { payment_method: method },
  });

  const businessConfig = await getBusinessConfig(business.id);
  const instructions =
    method === 'transfer'
      ? await getPaymentMethodInstructions(business.id, 'transfer')
      : null;

  const result = await buildUnpaidCheckoutResult(business, conversation, customer, {
    paymentMethod: method,
    externalDeliveryEnabled: businessConfig.external_delivery_enabled,
    instructions,
  });

  if (result.errorMessage) {
    return textResponse(result.errorMessage);
  }

  if (!result.message) {
    return noResponse();
  }

  return textResponse(result.message, result.followUps);
}

export class PayCashHandler implements IntentHandler {
  readonly command = ConversationIntent.PAY_CASH;

  canHandle(intent: string): boolean {
    return intent === ConversationIntent.PAY_CASH;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    return executeUnpaidMethod(ctx, 'cash');
  }
}

export class PayTransferHandler implements IntentHandler {
  readonly command = ConversationIntent.PAY_TRANSFER;

  canHandle(intent: string): boolean {
    return intent === ConversationIntent.PAY_TRANSFER;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    return executeUnpaidMethod(ctx, 'transfer');
  }
}

/** Ejecuta checkout unpaid según el método ya guardado en el draft (confirm step). */
export async function executeUnpaidCheckoutForDraftMethod(
  ctx: WebhookContext,
  method: PaymentMethodId
): Promise<HandlerResult | null> {
  return executeUnpaidMethod(ctx, method);
}
