import Stripe from "stripe";
import { env } from "../../config/env";

let stripeSingleton: Stripe | null | undefined;

export function isStripeConfigured(): boolean {
  return Boolean(env.STRIPE_SECRET_KEY?.trim());
}

/**
 * Cliente Stripe lazy. Devuelve null si no hay key (app arranca igual).
 */
export function getStripe(): Stripe | null {
  if (stripeSingleton !== undefined) {
    return stripeSingleton;
  }
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    console.warn(
      "[billing:stripe] STRIPE_SECRET_KEY ausente — Checkout/Portal/webhook sync deshabilitados"
    );
    stripeSingleton = null;
    return null;
  }
  stripeSingleton = new Stripe(key);
  return stripeSingleton;
}

/** Solo tests: resetear singleton. */
export function resetStripeClientForTests(): void {
  stripeSingleton = undefined;
}
