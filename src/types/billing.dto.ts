/** DTOs públicos de billing (admin + super-admin). */

export type BillingPlanDto = {
  code: string;
  name: string;
  monthly_price_usd: string | null;
  token_limit: number;
  conversations_per_month: number;
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

export type BillingLifecycleState =
  | "none"
  | "active"
  | "active_canceling"
  | "past_due"
  | "expired"
  | "unknown";

export type BillingActionsDto = {
  can_checkout: boolean;
  /** @deprecated usar `can_upgrade`/`can_downgrade`. */
  can_change_plan: boolean;
  can_cancel: boolean;
  can_reactivate: boolean;
  can_open_portal: boolean;
  can_upgrade: boolean;
  can_downgrade: boolean;
};

export type AdminBillingSubscriptionResponse = {
  requires_subscription: true;
  access_ok: boolean;
  /** @deprecated usar `billing_state` + `actions`. Se mantiene por compatibilidad mientras gesty-admin migra. */
  cta: "checkout" | "portal" | "none";
  billing_state: BillingLifecycleState;
  actions: BillingActionsDto;
  subscription: BillingSubscriptionSnapshotDto | null;
  quota: BillingQuotaDto;
};

export type AdminBillingCancelResponse = {
  billing_state: BillingLifecycleState;
  actions: BillingActionsDto;
  subscription: BillingSubscriptionSnapshotDto;
};

export type AdminBillingReactivateResponse = AdminBillingCancelResponse;

export type AdminBillingChangePlanResponse = {
  billing_state: BillingLifecycleState;
  actions: BillingActionsDto;
  subscription: BillingSubscriptionSnapshotDto;
  /**
   * `immediate_paid`: upgrade aplicado y la prorrata quedó confirmada como
   * pagada (evidencia de la factura, no solo el status de la suscripción).
   * `immediate_payment_pending`: el plan ya cambió, pero el pago de la
   * prorrata no se pudo confirmar como pagado (pendiente, falló, o no hay
   * evidencia suficiente) — nunca se devuelve `immediate_paid` sin esa
   * evidencia. `scheduled`: downgrade programado para el fin del período
   * vigente, el plan actual no cambió todavía.
   */
  billing: "immediate_paid" | "immediate_payment_pending" | "scheduled";
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
