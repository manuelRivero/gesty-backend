import type { Request, Response } from "express";
import { z } from "zod";
import { listActivePlans } from "../services/billing/planCatalog.service";
import {
  buildSubscriptionActionResult,
  getAdminBillingSubscription,
} from "../services/billing/adminBilling.service";
import {
  cancelOwnerSubscription,
  createBillingPortalSession,
  createCheckoutSession,
  reactivateSubscription,
} from "../services/billing/stripeCheckout.service";
import { changeSubscriptionPlan } from "../services/billing/subscriptionChangePlan.service";

function httpErrorStatus(err: unknown): number | null {
  if (
    err &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  ) {
    return (err as { status: number }).status;
  }
  return null;
}

export async function getAdminBillingPlans(
  req: Request,
  res: Response
): Promise<void> {
  const businessId = req.user?.businessId;
  if (!businessId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  const plans = await listActivePlans();
  res.json({ requires_subscription: true, plans });
}

export async function getAdminBillingSubscriptionHandler(
  req: Request,
  res: Response
): Promise<void> {
  const businessId = req.user?.businessId;
  if (!businessId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  const payload = await getAdminBillingSubscription(businessId);
  if (!payload) {
    res.status(404).json({ error: "Negocio no encontrado" });
    return;
  }
  res.json(payload);
}

const checkoutBodySchema = z.object({
  plan_code: z.string().min(1),
});

export async function postAdminBillingCheckout(
  req: Request,
  res: Response
): Promise<void> {
  const businessId = req.user?.businessId;
  if (!businessId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  const parsed = checkoutBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Body inválido",
      details: parsed.error.flatten(),
    });
    return;
  }

  try {
    const result = await createCheckoutSession({
      businessId,
      planCode: parsed.data.plan_code,
    });
    res.json(result);
  } catch (err) {
    const status = httpErrorStatus(err) ?? 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "Error en Checkout",
    });
  }
}

export async function postAdminBillingPortal(
  req: Request,
  res: Response
): Promise<void> {
  const businessId = req.user?.businessId;
  if (!businessId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  try {
    const result = await createBillingPortalSession({ businessId });
    res.json(result);
  } catch (err) {
    const status = httpErrorStatus(err) ?? 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "Error en Portal",
    });
  }
}

export async function postAdminBillingSubscriptionCancel(
  req: Request,
  res: Response
): Promise<void> {
  const businessId = req.user?.businessId;
  if (!businessId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  try {
    const { subscription } = await cancelOwnerSubscription(businessId);
    const result = await buildSubscriptionActionResult(businessId, subscription);
    res.json(result);
  } catch (err) {
    const status = httpErrorStatus(err) ?? 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "Error cancelando la suscripción",
    });
  }
}

export async function postAdminBillingSubscriptionReactivate(
  req: Request,
  res: Response
): Promise<void> {
  const businessId = req.user?.businessId;
  if (!businessId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  try {
    const { subscription } = await reactivateSubscription(businessId);
    const result = await buildSubscriptionActionResult(businessId, subscription);
    res.json(result);
  } catch (err) {
    const status = httpErrorStatus(err) ?? 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "Error reactivando la suscripción",
    });
  }
}

const changePlanBodySchema = z.object({
  plan_code: z.string().min(1),
});

export async function postAdminBillingSubscriptionChangePlan(
  req: Request,
  res: Response
): Promise<void> {
  const businessId = req.user?.businessId;
  if (!businessId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  const parsed = changePlanBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Body inválido",
      details: parsed.error.flatten(),
    });
    return;
  }

  try {
    const { subscription, billing } = await changeSubscriptionPlan(
      businessId,
      parsed.data.plan_code
    );
    const result = await buildSubscriptionActionResult(businessId, subscription);
    res.json({ ...result, billing });
  } catch (err) {
    const status = httpErrorStatus(err) ?? 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "Error cambiando de plan",
    });
  }
}
