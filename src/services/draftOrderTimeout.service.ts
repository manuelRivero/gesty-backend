import { prisma } from "../lib/prisma";
import { getBusinessConfig } from "./businessConfig.service";

/**
 * @internal Detalle de implementación de `touchSession`
 * (`src/services/sessionActivity.service.ts`), que es el único punto
 * autorizado para renovar el timeout de un draft por actividad del usuario.
 * La única llamada directa legítima fuera de `touchSession` es al crear un
 * `draft_order` nuevo, para fijar su primer `expires_at` (no es una
 * renovación, es la inicialización del valor).
 */
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