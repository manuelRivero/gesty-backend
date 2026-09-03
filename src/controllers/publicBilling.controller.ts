import type { Request, Response } from "express";
import { getPublicBillingPlans } from "../services/billing/planCatalog.service";

export async function getPublicBillingPlansHandler(
  _req: Request,
  res: Response
): Promise<void> {
  const payload = await getPublicBillingPlans();
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  res.json(payload);
}
