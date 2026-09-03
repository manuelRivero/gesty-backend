import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { findActivePlanByCode } from "./planCatalog.service";
import { getStripe, isStripeConfigured } from "./stripe.client";
import { getOrCreateStripeCustomerId } from "./stripeCustomer.service";
import {
  markSubscriptionDeletedFromStripe,
  resolveBusinessIdFromStripeSub,
  upsertSubscriptionFromStripe,
} from "./stripeSubscriptionSync.service";
import type { StripeSubscriptionLike } from "./mapStripeSubscription";
import type Stripe from "stripe";

function adminBaseUrl(): string {
  const origin = (env.CORS_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return origin || "http://localhost:3000";
}

export async function createCheckoutSession(input: {
  businessId: string;
  planCode: string;
}): Promise<{ url: string }> {
  const stripe = getStripe();
  if (!stripe || !isStripeConfigured()) {
    throw Object.assign(new Error("Stripe no configurado"), { status: 503 });
  }

  const plan = await findActivePlanByCode(input.planCode);
  if (!plan?.stripe_price_id) {
    throw Object.assign(new Error("Plan no disponible para suscripción"), {
      status: 400,
    });
  }

  const customerId = await getOrCreateStripeCustomerId(input.businessId);
  const base = adminBaseUrl();

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
    success_url: `${base}/billing?checkout=success`,
    cancel_url: `${base}/billing?checkout=cancel`,
    client_reference_id: input.businessId,
    metadata: {
      business_id: input.businessId,
      plan_code: plan.code,
    },
    subscription_data: {
      metadata: {
        business_id: input.businessId,
        plan_code: plan.code,
      },
    },
  });

  if (!session.url) {
    throw Object.assign(new Error("Stripe no devolvió URL de Checkout"), {
      status: 502,
    });
  }

  return { url: session.url };
}

export async function createBillingPortalSession(input: {
  businessId: string;
}): Promise<{ url: string }> {
  const stripe = getStripe();
  if (!stripe || !isStripeConfigured()) {
    throw Object.assign(new Error("Stripe no configurado"), { status: 503 });
  }

  const sub = await prisma.subscription.findUnique({
    where: { business_id: input.businessId },
  });
  if (!sub?.stripe_customer_id) {
    throw Object.assign(
      new Error("Suscribite primero para gestionar el plan"),
      { status: 400 }
    );
  }

  const base = adminBaseUrl();
  const session = await stripe.billingPortal.sessions.create({
    customer: sub.stripe_customer_id,
    return_url: `${base}/billing`,
  });

  return { url: session.url };
}

export async function cancelSubscriptionAtPeriodEnd(
  businessId: string
): Promise<void> {
  const stripe = getStripe();
  if (!stripe) {
    throw Object.assign(new Error("Stripe no configurado"), { status: 503 });
  }

  const sub = await prisma.subscription.findUnique({
    where: { business_id: businessId },
  });
  if (!sub?.stripe_subscription_id) {
    throw Object.assign(new Error("Sin suscripción Stripe"), { status: 400 });
  }

  const updated = await stripe.subscriptions.update(sub.stripe_subscription_id, {
    cancel_at_period_end: true,
  });
  await upsertSubscriptionFromStripe(
    updated as unknown as StripeSubscriptionLike,
    businessId
  );
}

export async function syncSubscriptionFromStripeApi(
  businessId: string
): Promise<void> {
  const stripe = getStripe();
  if (!stripe) {
    throw Object.assign(new Error("Stripe no configurado"), { status: 503 });
  }

  const sub = await prisma.subscription.findUnique({
    where: { business_id: businessId },
  });
  if (!sub?.stripe_subscription_id) {
    throw Object.assign(new Error("Sin suscripción Stripe para sincronizar"), {
      status: 400,
    });
  }

  const remote = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
  await upsertSubscriptionFromStripe(
    remote as unknown as StripeSubscriptionLike,
    businessId
  );
}

async function alreadyProcessed(eventId: string): Promise<boolean> {
  const existing = await prisma.stripe_webhook_event.findUnique({
    where: { stripe_event_id: eventId },
  });
  return Boolean(existing);
}

async function markProcessed(event: Stripe.Event): Promise<void> {
  try {
    await prisma.stripe_webhook_event.create({
      data: {
        stripe_event_id: event.id,
        type: event.type,
        payload: event as unknown as object,
      },
    });
  } catch {
    // unique race — ok
  }
}

export async function processStripeWebhookEvent(
  event: Stripe.Event
): Promise<void> {
  if (await alreadyProcessed(event.id)) {
    return;
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const businessId =
        session.metadata?.business_id?.trim() ||
        session.client_reference_id?.trim() ||
        null;
      const subId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;
      if (businessId && subId) {
        const stripe = getStripe();
        if (stripe) {
          const remote = await stripe.subscriptions.retrieve(subId);
          await upsertSubscriptionFromStripe(
            remote as unknown as StripeSubscriptionLike,
            businessId
          );
        }
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const stripeSub = event.data.object as unknown as StripeSubscriptionLike;
      const businessId = await resolveBusinessIdFromStripeSub(stripeSub);
      if (businessId) {
        await upsertSubscriptionFromStripe(stripeSub, businessId);
      } else {
        console.warn(
          `[billing:stripe] webhook ${event.type} sin business_id resoluble`,
          stripeSub.id
        );
      }
      break;
    }
    case "customer.subscription.deleted": {
      const stripeSub = event.data.object as Stripe.Subscription;
      await markSubscriptionDeletedFromStripe(stripeSub.id);
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const parentSub = invoice.parent?.subscription_details?.subscription;
      const subId =
        typeof parentSub === "string" ? parentSub : parentSub?.id ?? null;
      if (subId) {
        const stripe = getStripe();
        if (stripe) {
          const remote = await stripe.subscriptions.retrieve(subId);
          const businessId = await resolveBusinessIdFromStripeSub(
            remote as unknown as StripeSubscriptionLike
          );
          if (businessId) {
            await upsertSubscriptionFromStripe(
              remote as unknown as StripeSubscriptionLike,
              businessId
            );
          }
        }
      }
      break;
    }
    default:
      break;
  }

  await markProcessed(event);
}
