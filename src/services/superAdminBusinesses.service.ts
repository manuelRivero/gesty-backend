import type { business, subscription } from "@prisma/client";
import { prisma } from "../lib/prisma";
import type {
  BusinessWithSubscriptionDto,
  SuperAdminBusinessListResponse,
  SuperAdminSubscriptionDto,
  SuperAdminSubscriptionPlanName,
  SuperAdminSubscriptionStatus
} from "../types/superAdminBusiness.dto";

type BusinessWithSub = business & { subscription: subscription | null };

function addMonths(d: Date, n: number): Date {
  const x = new Date(d.getTime());
  x.setUTCMonth(x.getUTCMonth() + n);
  return x;
}

/** Evita límite 0 en porcentajes de la UI. */
function safeTokenLimit(limit: number): number {
  return Math.max(1, limit);
}

/** `business.ai_plan` en BD suele ser lowercase; el front usa literales capitalizados. */
export function aiPlanToDisplayName(aiPlan: string | null | undefined): SuperAdminSubscriptionPlanName {
  const raw = (aiPlan ?? "basic").trim().toLowerCase();
  if (raw === "pro") {
    return "Pro";
  }
  if (raw === "business" || raw === "enterprise") {
    return "Business";
  }
  if (raw === "trial") {
    return "Trial";
  }
  return "Basic";
}

/** Mapea estados típicos de Stripe a los literales del contrato del front. */
export function mapStripeStatusToUi(
  status: string | null | undefined
): SuperAdminSubscriptionStatus {
  const s = (status ?? "").toLowerCase();
  if (s === "past_due" || s === "unpaid") {
    return "past_due";
  }
  if (
    s === "canceled" ||
    s === "cancelled" ||
    s === "incomplete_expired" ||
    s === "ended"
  ) {
    return "canceled";
  }
  return "active";
}

function buildSubscriptionDto(b: BusinessWithSub): SuperAdminSubscriptionDto {
  if (b.subscription) {
    const sub = b.subscription;
    return {
      plan_name: aiPlanToDisplayName(b.ai_plan),
      current_period_start: sub.current_period_start.toISOString(),
      current_period_end: sub.current_period_end.toISOString(),
      status: mapStripeStatusToUi(sub.status)
    };
  }
  const start = b.ai_reset_at;
  const end = addMonths(start, 1);
  return {
    plan_name: aiPlanToDisplayName(b.ai_plan),
    current_period_start: start.toISOString(),
    current_period_end: end.toISOString(),
    status: "active"
  };
}

export function toBusinessWithSubscriptionDto(b: BusinessWithSub): BusinessWithSubscriptionDto {
  return {
    id: b.id,
    name: b.name,
    ai_blocked: b.ai_blocked,
    ai_monthly_tokens_used: b.ai_monthly_tokens_used,
    ai_monthly_token_limit: safeTokenLimit(b.ai_monthly_token_limit),
    created_at: b.created_at.toISOString(),
    subscription: buildSubscriptionDto(b)
  };
}

export async function listBusinessesForSuperAdmin(params: {
  skip: number;
  take: number;
  q?: string;
}): Promise<SuperAdminBusinessListResponse> {
  const q = params.q?.trim();
  const where =
    q && q.length > 0
      ? { name: { contains: q, mode: "insensitive" as const } }
      : {};

  const [rows, total] = await Promise.all([
    prisma.business.findMany({
      where,
      skip: params.skip,
      take: params.take,
      orderBy: { created_at: "desc" },
      include: { subscription: true }
    }),
    prisma.business.count({ where })
  ]);

  return {
    items: rows.map(toBusinessWithSubscriptionDto),
    total
  };
}

export async function getBusinessWithSubscriptionForSuperAdmin(
  id: string
): Promise<BusinessWithSubscriptionDto | null> {
  const row = await prisma.business.findUnique({
    where: { id },
    include: { subscription: true }
  });
  if (!row) {
    return null;
  }
  return toBusinessWithSubscriptionDto(row);
}
