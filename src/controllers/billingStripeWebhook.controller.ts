import type { Request, Response } from "express";
import { getStripe } from "../services/billing/stripe.client";
import { processStripeWebhookEvent } from "../services/billing/stripeCheckout.service";
import { env } from "../config/env";

/**
 * Webhook Stripe — requiere body raw (Buffer) para verificar firma.
 */
export async function billingStripeWebhookHandler(
  req: Request,
  res: Response
): Promise<void> {
  const stripe = getStripe();
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim();

  if (!stripe || !secret) {
    console.warn("[billing:stripe] webhook recibido sin Stripe configurado");
    res.status(503).json({ error: "Stripe no configurado" });
    return;
  }

  const sig = req.headers["stripe-signature"];
  if (!sig || typeof sig !== "string") {
    res.status(400).json({ error: "Falta stripe-signature" });
    return;
  }

  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    res.status(400).json({
      error: "Body raw requerido para verificar firma Stripe",
    });
    return;
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    console.warn(
      "[billing:stripe] firma inválida",
      err instanceof Error ? err.message : err
    );
    res.status(400).json({ error: "Firma inválida" });
    return;
  }

  try {
    await processStripeWebhookEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error("[billing:stripe] error procesando evento", event.type, err);
    res.status(500).json({ error: "Error procesando evento" });
  }
}
