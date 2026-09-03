/** DTOs públicos de billing (admin + super-admin). */

export type BillingPlanDto = {
  code: string;
  name: string;
  monthly_price_usd: string | null;
  token_limit: number;
  description: string | null;
  features: unknown;
  has_stripe_price: boolean;
  can_subscribe: boolean;
};

export type BillingSubscriptionSnapshotDto = {
  status: string;
  is_trial: boolean;
  trial_end: string | null;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  plan_code: string | null;
  plan_name: string;
  stripe_customer_id: string | null;
  has_stripe_subscription: boolean;
};

export type BillingQuotaDto = {
  tokens_used: number;
  tokens_limit: number;
  tokens_remaining: number;
  ai_blocked: boolean;
  has_quota: boolean;
  reset_at: string;
};

export type AdminBillingSubscriptionResponse = {
  requires_subscription: true;
  access_ok: boolean;
  cta: "checkout" | "portal" | "none";
  subscription: BillingSubscriptionSnapshotDto | null;
  quota: BillingQuotaDto;
};

export type AdminBillingPlansResponse = {
  requires_subscription: true;
  plans: BillingPlanDto[];
};

export type SuperAdminBillingDetailDto = {
  business_id: string;
  business_name: string;
  access_ok: boolean;
  has_subscription_row: boolean;
  ai_plan: string;
  ai_monthly_token_limit: number;
  ai_monthly_tokens_used: number;
  ai_blocked: boolean;
  subscription: BillingSubscriptionSnapshotDto | null;
  quota: BillingQuotaDto;
};
