import { FulfillmentType } from "@prisma/client";
import { assertNever } from "../lib/assertNever";

/**
 * Narrowing de `FulfillmentType | null` (el tipo real de `draft_order`/`orders`)
 * al subconjunto `'DELIVERY' | 'TAKE_AWAY' | null` que consume el copy del
 * carrito conversacional de WhatsApp (`cartShippingCopy.ts`). Un `draft_order`
 * de bot nunca debería tener `DINE_IN` — las rondas de salón se crean directo
 * en `orders` vía `adminTableTabRound.service.ts`, nunca pasan por
 * `draft_order` (POS_TECHNICAL_DESIGN.md §4.B) — pero el campo comparte el
 * enum de Prisma, así que TypeScript exige manejarlo. `switch` exhaustivo:
 * si esto se alcanza alguna vez con `DINE_IN`, se trata como "sin elegir"
 * (`null`) en vez de que el build se rompa en producción.
 */
export function toBotFulfillmentType(
  fulfillmentType: FulfillmentType | null | undefined
): "DELIVERY" | "TAKE_AWAY" | null {
  if (fulfillmentType == null) {
    return null;
  }
  switch (fulfillmentType) {
    case FulfillmentType.DELIVERY:
      return "DELIVERY";
    case FulfillmentType.TAKE_AWAY:
      return "TAKE_AWAY";
    case FulfillmentType.DINE_IN:
      return null;
    default:
      return assertNever(fulfillmentType);
  }
}
