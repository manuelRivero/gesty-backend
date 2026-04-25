// webhooks/handlers/orderSearchPageHandler.ts
import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { listResponse, parsePageOnly, textResponse } from '../utils';
import { handleOrderSearchPageFromWebhook } from '../../../services/whatsapp.service';
import { ConversationIntent } from '../../../types/conversationIntent';

export class OrderSearchPageHandler implements IntentHandler {
    readonly command = ConversationIntent.ORDER_SEARCH_PAGE;
    
    canHandle(intent: string): boolean {
      return intent === ConversationIntent.ORDER_SEARCH_PAGE;
    }
  
    async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
      const page = parsePageOnly(ctx.payloadId!);
      
      const result = await handleOrderSearchPageFromWebhook(ctx.payload, page);
      
      // Manejo de errores silenciosos
      if (result === null) {
        return null; // No se envía mensaje (error ya logueado en servicio)
      }
      
      // Mensaje de texto (error de metadata expirada)
      if (typeof result === 'string') {
        return textResponse(result);
      }
      
      // WhatsAppListMessage exitoso
      return listResponse(result);
    }
  }
  