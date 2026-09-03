import type Stripe from "stripe";

/** Stripe Subscription tipado con campos de periodo usados en sync. */
export type StripeSubscriptionLike = {
  id: string;
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null;
  status: Stripe.Subscription.Status;
  cancel_at_period_end: boolean;
  current_period_start?: number;
  current_period_end?: number;
  trial_end?: number | null;
  items?: {
    data: Array<{
      current_period_start?: number;
      current_period_end?: number;
      price?: { id?: string | null } | null;
    }>;
  };
  metadata?: Stripe.Metadata;
};

export function stripeCustomerId(
  customer: StripeSubscriptionLike["customer"]
): string | null {
  if (!customer) return null;
  if (typeof customer === "string") return customer;
  if ("deleted" in customer && customer.deleted) return null;
  return customer.id;
}

export function mapStripeStatus(status: string): string {
  return status.trim().toLowerCase();
}

export function periodDatesFromStripeSub(sub: StripeSubscriptionLike): {
  start: Date;
  end: Date;
} {
  const item = sub.items?.data?.[0];
  const startSec = sub.current_period_start ?? item?.current_period_start;
  const endSec = sub.current_period_end ?? item?.current_period_end;
  const now = Date.now();
  return {
    start: startSec != null ? new Date(startSec * 1000) : new Date(now),
    end:
      endSec != null
        ? new Date(endSec * 1000)
        : new Date(now + 30 * 24 * 60 * 60 * 1000),
  };
}

export function priceIdFromStripeSub(sub: StripeSubscriptionLike): string | null {
  return sub.items?.data?.[0]?.price?.id ?? null;
}
