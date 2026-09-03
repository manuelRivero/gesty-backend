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
  ai_plan: string;
  ai_blocked: boolean;
  ai_monthly_tokens_used: number;
  ai_monthly_token_limit: number;
  created_at: string;
  has_subscription_row: boolean;
  access_ok: boolean;
  is_trial: boolean;
  trial_end: string | null;
  subscription: SuperAdminSubscriptionDto;
};

export type SuperAdminBusinessListResponse = {
  items: BusinessWithSubscriptionDto[];
  total: number;
};

export type SuperAdminCreatedOwnerDto = {
  user_id: string;
  email: string;
  name: string | null;
  created: boolean;
};

export type SuperAdminCreateBusinessResponse = BusinessWithSubscriptionDto & {
  owner: SuperAdminCreatedOwnerDto;
};
