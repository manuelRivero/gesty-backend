import { prisma } from "../../lib/prisma";
import type { BillingPlanDto } from "../../types/billing.dto";
import { isStripeConfigured } from "./stripe.client";
import { conversationsFromTokenLimit } from "../../constants/planCatalog";
import {
  DEFAULT_TRIAL_DAYS,
  DEFAULT_TRIAL_TOKEN_LIMIT,
  TRIAL_CONVERSATIONS,
} from "../../constants/billing";

export async function listActivePlans(opts?: {
  canSubscribe?: boolean;
}): Promise<BillingPlanDto[]> {
  const rows = await prisma.plan.findMany({
    where: { is_active: true },
    orderBy: { monthly_price_usd: "asc" },
  });

  const stripeOk = opts?.canSubscribe ?? isStripeConfigured();

  return rows.map((p) => {
    const hasPrice = Boolean(p.stripe_price_id);
    const features =
      p.features && typeof p.features === "object" && !Array.isArray(p.features)
        ? (p.features as Record<string, unknown>)
        : {};
    const fromFeatures = Number(features.conversations_per_month);
    const conversations_per_month =
      Number.isFinite(fromFeatures) && fromFeatures > 0
        ? fromFeatures
        : conversationsFromTokenLimit(p.token_limit);

    return {
      code: p.code,
      name: p.name,
      monthly_price_usd:
        p.monthly_price_usd != null ? p.monthly_price_usd.toString() : null,
      token_limit: p.token_limit,
      conversations_per_month,
      description: p.description ?? null,
      features,
      has_stripe_price: hasPrice,
      can_subscribe: stripeOk && hasPrice,
    };
  });
}

export async function findActivePlanByCode(code: string) {
  return prisma.plan.findFirst({
    where: { code, is_active: true },
  });
}

export type PublicTrialDto = {
  code: "trial";
  name: string;
  days: number;
  monthly_price_usd: null;
  conversations_per_month: number;
  conversations_label: string;
  token_limit: number;
  description: string;
  highlights: string[];
};

export type PublicPaidPlanDto = {
  code: string;
  name: string;
  monthly_price_usd: string | null;
  conversations_per_month: number;
  conversations_label: string;
  token_limit: number;
  description: string | null;
  highlights: string[];
};

export type PublicBillingPlansResponse = {
  currency: "USD";
  interval: "month";
  trial: PublicTrialDto;
  plans: PublicPaidPlanDto[];
};

function highlightsFromFeatures(features: Record<string, unknown>): string[] {
  const raw = features.highlights;
  if (!Array.isArray(raw)) return [];
  return raw.filter((h): h is string => typeof h === "string");
}

function conversationsLabel(
  features: Record<string, unknown>,
  conversations: number
): string {
  const label = features.conversations_label;
  if (typeof label === "string" && label.trim()) return label;
  return `~${conversations.toLocaleString("es-AR")} conv/mes`;
}

export async function getPublicBillingPlans(): Promise<PublicBillingPlansResponse> {
  const paid = (await listActivePlans({ canSubscribe: false })).filter(
    (p) => p.code !== "trial"
  );

  return {
    currency: "USD",
    interval: "month",
    trial: {
      code: "trial",
      name: "Free Trial",
      days: DEFAULT_TRIAL_DAYS,
      monthly_price_usd: null,
      conversations_per_month: TRIAL_CONVERSATIONS,
      conversations_label: `~${TRIAL_CONVERSATIONS} conv. de prueba`,
      token_limit: DEFAULT_TRIAL_TOKEN_LIMIT,
      description:
        "Explorá todo lo que Gesty puede hacer por tu negocio, sin compromisos ni tarjeta de crédito.",
      highlights: [
        "Acceso completo a Gesty",
        `Prueba de ${DEFAULT_TRIAL_DAYS} días sin costo`,
        `~${TRIAL_CONVERSATIONS} conversaciones de prueba incluidas`,
        "Ideal para explorar la automatización IA",
      ],
    },
    plans: paid.map((p) => {
      const features =
        p.features && typeof p.features === "object" && !Array.isArray(p.features)
          ? (p.features as Record<string, unknown>)
          : {};
      return {
        code: p.code,
        name: p.name,
        monthly_price_usd: p.monthly_price_usd,
        conversations_per_month: p.conversations_per_month,
        conversations_label: conversationsLabel(
          features,
          p.conversations_per_month
        ),
        token_limit: p.token_limit,
        description: p.description,
        highlights: highlightsFromFeatures(features),
      };
    }),
  };
}
