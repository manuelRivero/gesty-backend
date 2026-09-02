export type BusinessAiQuotaDto = {
  tokens_used: number;
  tokens_limit: number;
  tokens_remaining: number;
  ai_blocked: boolean;
  has_quota: boolean;
  reset_at: string;
  subscription: {
    status: string;
    is_trial: boolean;
    current_period_start: string;
    current_period_end: string;
    plan_name: string;
  };
};
