/** Respuesta API super-admin: mismos nombres que espera el front (snake_case). */

export type SuperAdminSubscriptionPlanName = "Basic" | "Pro" | "Business" | "Trial";
export type SuperAdminSubscriptionStatus = "active" | "past_due" | "canceled";

export type SuperAdminSubscriptionDto = {
  plan_name: SuperAdminSubscriptionPlanName;
  current_period_start: string;
  current_period_end: string;
  status: SuperAdminSubscriptionStatus;
};

export type BusinessWithSubscriptionDto = {
  id: string;
  name: string;
  ai_blocked: boolean;
  ai_monthly_tokens_used: number;
  ai_monthly_token_limit: number;
  created_at: string;
  subscription: SuperAdminSubscriptionDto;
};

export type SuperAdminBusinessListResponse = {
  items: BusinessWithSubscriptionDto[];
  total: number;
};
