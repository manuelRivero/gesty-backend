// src/controllers/webhook/handlers/orderFoodHandler.ts

import { IntentHandler, EnrichedContext, HandlerResult, IntentClassification } from '../types';
import { textResponse } from '../utils';
import { generateOrderResolution } from '../../../services/ai/openai.service';
import { ConversationIntent } from '../../../types/conversationIntent';
import { prisma } from '../../../lib/prisma';

interface OrderAction {
  action: 'add' | 'remove' | 'set_quantity';
  product_name: string;
  quantity: number;
}

export class OrderFoodHandler implements IntentHandler {
  readonly command = ConversationIntent.ORDER_FOOD;
  private customerPhone: string = '';
  private businessId: string = '';

  canHandle(intent: string): boolean {
    return intent === ConversationIntent.ORDER_FOOD;
  }

  async execute(
    ctx: EnrichedContext,
  ): Promise<HandlerResult | null> {

    this.customerPhone = ctx.to;
    this.businessId = ctx.business.id || '';

    console.log('[OrderFoodHandler] Executing');

    const { conversation, detection } = ctx;
    const userMessage = ctx.message?.text?.body || '';

    const currentItems = await this.getCurrentOrderItems();

    console.log('[OrderFoodHandler] Current items:', currentItems.length);

    const resolution = await generateOrderResolution({
      userMessage,
      currentOrderItems: currentItems
    });

    console.log('[OrderFoodHandler] Resolution:', {
      actions: resolution.actions.length,
      needsClarification: resolution.needs_clarification
    });

    if (resolution.needs_clarification && currentItems.length > 0) {
      return this.buildClarificationList(currentItems);
    }

    if (resolution.actions.length === 0 && detection.detectedProductName) {
      resolution.actions.push({
        action: 'add',
        product_name: detection.detectedProductName,
        quantity: detection.quantity || 1
      });
    }

    const action = resolution.actions[0];
    if (!action) {
      return textResponse('No entendí qué querés pedir. ¿Podés ser más específico?');
    }

    console.log('[OrderFoodHandler] Action:', action.action, '→', action.product_name);

    switch (action.action) {
      case 'add':
        return await this.handleAddProduct(ctx, action);
      case 'remove':
        return await this.delegateToRemove(ctx, action);
      case 'set_quantity':
        return await this.handleSetQuantity(ctx, action);
      default:
        return textResponse('Acción no reconocida.');
    }
  }

  private async getCurrentOrderItems(){
    try {
      // Obtener customer_phone del contexto
      const customerPhone = this.customerPhone;
      const businessId = this.businessId;

      if (!customerPhone || !businessId) {
        console.log('[OrderFoodHandler] Missing customerPhone or businessId');
        return [];
      }

      const draftOrder = await prisma.draft_order.findFirst({
        where: {
          business_id: businessId,
          customer_phone: customerPhone,  // ← CORREGIDO: usar customer_phone, no conversation_id
          status: 'active'
        },
        include: {
          draft_order_item: {  // ← Nombre correcto según tu schema
            include: { menu_item: true }
          }
        }
      });

      if (draftOrder) {
        return (draftOrder.draft_order_item as any[]).map((item: any) => ({
          name: item.menu_item?.name || 'Producto',
          quantity: item.quantity
        }));
      }

      // Si no hay draft_order, retornar vacío (no buscar en order por ahora)
      return [];

    } catch (error) {
      console.error
      return [];
    }
  }
  private async handleAddProduct(ctx: EnrichedContext, action: OrderAction): Promise<HandlerResult | null> {
    return textResponse(
      `Perfecto, voy a agregar ${action.quantity} ${action.product_name} a tu pedido. ` +
      `(Implementación completa pendiente)`
    );
  }

  private async delegateToRemove(ctx: EnrichedContext, action: OrderAction): Promise<HandlerResult | null> {
    const { RemoveItemHandler } = await import('./removeItemHandler');
    const removeHandler = new RemoveItemHandler();

    const artificialClassification: IntentClassification = {
      intent: ConversationIntent.REMOVE_ITEM,
      confidence: 1,
      detectedProductName: action.product_name,
      quantity: action.quantity
    };

    return removeHandler.execute(ctx);
  }

  private async handleSetQuantity(ctx: EnrichedContext, action: OrderAction): Promise<HandlerResult | null> {
    return textResponse(
      `Voy a cambiar ${action.product_name} a cantidad ${action.quantity}. ` +
      `(Implementación completa pendiente)`
    );
  }

  private buildClarificationList(items: Array<{ name: string, quantity: number }>): HandlerResult {
    const itemList = items.map(i => `${i.quantity}x ${i.name}`).join(', ');
    return textResponse(`¿Cuál producto querés modificar? Tenés: ${itemList}`);
  }
}