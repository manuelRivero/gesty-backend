// webhooks/handlers/selectOrderProductHandler.ts
import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { listResponse, noResponse, parseProductId, textResponse } from '../utils';
import { handleOrderProductSelectionFromWebhook } from '../../../services/whatsapp.service';
import { ConversationIntent } from '../../../types/conversationIntent';

export class SelectOrderProductHandler implements IntentHandler {
  readonly command = ConversationIntent.SELECT_ORDER_PRODUCT;
  
  canHandle(intent: string): boolean {
    return intent === ConversationIntent.SELECT_ORDER_PRODUCT;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const productId = parseProductId(ctx.payloadId!);
    
    const content = await handleOrderProductSelectionFromWebhook(ctx.payload, productId);
    
    // Manejar string vacío como error silencioso
    if (!content) {
      return noResponse();
    }

    // Detectar tipo: string = texto, objeto = lista
    if (typeof content === 'string') {
      return textResponse(content);
    }

    // Es WhatsAppListMessage
    return listResponse(content);
  }
}