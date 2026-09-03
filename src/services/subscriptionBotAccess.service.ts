import type { business } from "@prisma/client";
import {
  evaluateBusinessBillingAccess,
} from "./billing/evaluateBusinessBillingAccess.service";

/**
 * @deprecated Preferí `evaluateBusinessBillingAccess`.
 * Delega al evaluador unificado (suscripción obligatoria).
 */
export async function evaluateSubscriptionForBotAi(
  business: business
): Promise<
  | { ok: true; business: business }
  | { ok: false; message: string }
> {
  return evaluateBusinessBillingAccess(business);
}
