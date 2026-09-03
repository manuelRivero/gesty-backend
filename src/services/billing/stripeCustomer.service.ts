import { prisma } from "../../lib/prisma";
import { getStripe } from "./stripe.client";

/**
 * Obtiene o crea Customer Stripe para el business.
 * Persiste `stripe_customer_id` en la fila subscription (crea placeholder trial-like si no hay).
 */
export async function getOrCreateStripeCustomerId(
  businessId: string
): Promise<string> {
  const stripe = getStripe();
  if (!stripe) {
    throw new Error("Stripe no configurado");
  }

  const business = await prisma.business.findUnique({
    where: { id: businessId },
  });
  if (!business) {
    throw new Error("Negocio no encontrado");
  }

  const existing = await prisma.subscription.findUnique({
    where: { business_id: businessId },
  });
  if (existing?.stripe_customer_id) {
    return existing.stripe_customer_id;
  }

  const customer = await stripe.customers.create({
    name: business.name,
    metadata: { business_id: businessId },
  });

  const now = new Date();
  if (existing) {
    await prisma.subscription.update({
      where: { business_id: businessId },
      data: {
        stripe_customer_id: customer.id,
        updated_at: now,
      },
    });
  } else {
    await prisma.subscription.create({
      data: {
        business_id: businessId,
        stripe_customer_id: customer.id,
        stripe_subscription_id: null,
        status: "incomplete",
        is_trial: false,
        current_period_start: now,
        current_period_end: now,
      },
    });
  }

  return customer.id;
}
