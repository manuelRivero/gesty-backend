// src/services/intentService.ts
import { WhatsAppWebhookPayload } from "../controllers/webhook/types";
import { prisma } from "../lib/prisma";

export const extractOrderContext = async (
    payload: WhatsAppWebhookPayload
  ): Promise<{
    lastMessage: string;
    items: Array<{ name: string; quantity: number }>;
  }> => {
    
    const entry = payload.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    const from = message?.from;
    const phoneNumberId = value?.metadata?.phone_number_id;
  
    // Extraer mensaje del usuario
    const lastMessage = message?.text?.body || '';
  
    if (!phoneNumberId || !from) {
      return { lastMessage, items: [] };
    }
  
    // Buscar business y conversation
    const { findBusinessByPhoneNumberId, findOrCreateCustomer, createOrGetOpenConversation } = await import('../repositories');
    
    const business = await findBusinessByPhoneNumberId(phoneNumberId);
    if (!business) {
      return { lastMessage, items: [] };
    }
  
    const customer = await findOrCreateCustomer(business.id, from);
    const conversation = await createOrGetOpenConversation(business.id, customer.id);
  
    // Buscar items del pedido actual (draft_order o cart)
    const draftOrder = await prisma.draft_order.findFirst({
      where: {
        business_id: business.id,
        customer_phone: from,
        status: 'active'
      },
      include: {
        draft_order_item: {
          include: { menu_item: true }
        }
      }
    });
  
    if (!draftOrder) {
      return { lastMessage, items: [] };
    }
  
    const items = draftOrder.draft_order_item.map(item => ({
      name: item.menu_item?.name || 'Producto',
      quantity: item.quantity
    }));
  
    return { lastMessage, items };
  };
