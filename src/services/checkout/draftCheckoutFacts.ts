/**
 * Facts recolectados en la sesión de checkout sobre el draft (entrega, pago, fee).
 * No incluye customer.name ni dirección guardada: esos viven en el cliente
 * y se reutilizan en el próximo pedido.
 */

import { prisma } from '../../lib/prisma';

export const DRAFT_CHECKOUT_COLLECTED_FACTS_RESET = {
  fulfillment_type: null,
  payment_method: null,
  delivery_fee: null,
};

export async function resetDraftCheckoutCollectedFacts(draftId: string): Promise<void> {
  await prisma.draft_order.update({
    where: { id: draftId },
    data: DRAFT_CHECKOUT_COLLECTED_FACTS_RESET,
  });
}

/** Draft activo del cliente: limpia Facts de checkout y deja el carrito. */
export async function resetActiveDraftCheckoutFacts(
  businessId: string,
  customerPhone: string
): Promise<void> {
  const draft = await prisma.draft_order.findFirst({
    where: { business_id: businessId, customer_phone: customerPhone, status: 'active' },
    select: { id: true },
  });
  if (!draft) return;
  await resetDraftCheckoutCollectedFacts(draft.id);
}
