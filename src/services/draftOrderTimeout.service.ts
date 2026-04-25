import { prisma } from "../lib/prisma";
import { getBusinessConfig } from "./businessConfig.service";

export const refreshDraftOrderTimeout = async (
    draftOrderId: string
  ) => {
    const order = await prisma.draft_order.findUnique({
      where: { id: draftOrderId },
      select: { business_id: true }
    });
    const cfg = order?.business_id
      ? await getBusinessConfig(order.business_id)
      : null;
    const expireMinutes = cfg?.draft_order_expire_minutes ?? 2;
    const expiresAt = new Date(Date.now() + expireMinutes * 60000);
  
    await prisma.draft_order.update({
      where: { id: draftOrderId },
      data: {
        expires_at: expiresAt,
        reminder_sent_at: null
      }
    });
  
  };