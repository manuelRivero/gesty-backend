/**
 * Catálogo comercial Gesty (landing https://www.gesty.online/).
 *
 * La web cotiza en conversaciones/mes; internamente medimos tokens OpenAI.
 * Ratio: 100_000 tokens (Basic) / ~2.500 conv = 40 tokens por conversación promedio.
 */

export const TOKENS_PER_CONVERSATION = 40;

export function conversationsFromTokenLimit(tokenLimit: number): number {
  return Math.round(tokenLimit / TOKENS_PER_CONVERSATION);
}

export function tokenLimitFromConversations(conversations: number): number {
  return conversations * TOKENS_PER_CONVERSATION;
}

export type PaidPlanCode = "basic" | "pro" | "business";

export type PlanCatalogEntry = {
  code: PaidPlanCode;
  name: string;
  monthly_price_usd: string;
  conversations_per_month: number;
  token_limit: number;
  description: string;
  features: {
    conversations_per_month: number;
    conversations_label: string;
    highlights: string[];
  };
};

export const PAID_PLAN_CATALOG: PlanCatalogEntry[] = [
  {
    code: "basic",
    name: "Basic",
    monthly_price_usd: "45.00",
    conversations_per_month: 2500,
    token_limit: tokenLimitFromConversations(2500),
    description:
      "Ideal para pequeños negocios que automatizan la atención al cliente en WhatsApp.",
    features: {
      conversations_per_month: 2500,
      conversations_label: "~2.500 conv/mes",
      highlights: [
        "Acceso completo a Gesty",
        "Conversaciones automatizadas 24/7",
        "Soporte de onboarding incluido",
      ],
    },
  },
  {
    code: "pro",
    name: "Pro",
    monthly_price_usd: "95.00",
    conversations_per_month: 7000,
    token_limit: tokenLimitFromConversations(7000),
    description:
      "Perfecto para negocios en crecimiento que manejan un volumen constante de conversaciones.",
    features: {
      conversations_per_month: 7000,
      conversations_label: "~7.000 conv/mes",
      highlights: [
        "Acceso completo a Gesty",
        "Mayor capacidad operativa",
        "Automatización estable para alta demanda",
      ],
    },
  },
  {
    code: "business",
    name: "Business",
    monthly_price_usd: "195.00",
    conversations_per_month: 20000,
    token_limit: tokenLimitFromConversations(20000),
    description:
      "Creado para empresas que operan a gran escala de conversaciones en WhatsApp.",
    features: {
      conversations_per_month: 20000,
      conversations_label: "~20.000+ conv/mes",
      highlights: [
        "Acceso completo a Gesty",
        "Gestión de conversaciones a gran escala",
        "Implementación guiada por el equipo",
      ],
    },
  },
];

export const TRIAL_CONVERSATIONS = 500;

export function getPaidPlanByCode(code: string): PlanCatalogEntry | undefined {
  const normalized = code === "enterprise" ? "business" : code;
  return PAID_PLAN_CATALOG.find((p) => p.code === normalized);
}
