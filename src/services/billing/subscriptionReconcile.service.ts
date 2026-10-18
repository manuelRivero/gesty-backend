import type { subscription } from "@prisma/client";
import type Stripe from "stripe";
import { prisma } from "../../lib/prisma";
import { upsertSubscriptionFromStripe } from "./stripeSubscriptionSync.service";
import type { StripeSubscriptionLike } from "./mapStripeSubscription";

/**
 * Lectura + reconciliación contra Stripe de la suscripción de un negocio,
 * para usar SIEMPRE dentro de `withBillingLock` (`billingLock.ts`) — nunca
 * de forma aislada, porque el valor de esto es justamente que nadie más
 * pueda mutar `subscription` entre que se lee el estado remoto y que se
 * decide/ejecuta la operación.
 *
 * No alcanza con leer la fila local: puede estar desactualizada (un webhook
 * lento, o un proceso anterior que cayó después de que Stripe aplicó algo
 * pero antes de persistirlo). Por eso esto SIEMPRE retira el estado real de
 * Stripe primero (si ya existe `stripe_subscription_id`) y lo sincroniza vía
 * el mecanismo canónico (`upsertSubscriptionFromStripe`) antes de devolver
 * la fila local — que a partir de ahí sí refleja la verdad remota al
 * momento de esta llamada.
 *
 * Que esto confirme el estado remoto actual no implica que una intención
 * previa (ej. un cambio de plan anterior que quedó indeterminado) se haya
 * completado como se esperaba — solo demuestra cuál es el estado actual.
 * Cada operación sigue decidiendo por su cuenta qué significa ese estado
 * para la mutación que está a punto de ejecutar.
 */
export async function reconcileLiveSubscription(
  stripe: Stripe,
  businessId: string
): Promise<{ local: subscription | null; remote: Stripe.Subscription | null }> {
  const local = await prisma.subscription.findUnique({
    where: { business_id: businessId },
  });

  if (!local?.stripe_subscription_id) {
    return { local, remote: null };
  }

  const remote = await stripe.subscriptions.retrieve(local.stripe_subscription_id);
  await upsertSubscriptionFromStripe(
    remote as unknown as StripeSubscriptionLike,
    businessId
  );
  const refreshed = await prisma.subscription.findUnique({
    where: { business_id: businessId },
  });
  return { local: refreshed, remote };
}
