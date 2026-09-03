import { beforeEach, describe, expect, it, vi } from "vitest";
import type { business, subscription } from "@prisma/client";

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    subscription: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("../../ai/aiUsage.service", () => ({
  resetIfNeeded: vi.fn(async (b: business) => b),
}));

import { prisma } from "../../../lib/prisma";
import {
  BILLING_ACCESS_MESSAGES,
  evaluateBusinessBillingAccess,
  evaluateSubscriptionRowAccess,
} from "../evaluateBusinessBillingAccess.service";

const mockedFindSubscription = prisma.subscription.findUnique as unknown as ReturnType<
  typeof vi.fn
>;

function buildBusiness(overrides: Partial<business> = {}): business {
  return {
    id: "biz-1",
    name: "Test",
    ai_monthly_tokens_used: 1_000,
    ai_monthly_token_limit: 100_000,
    ai_plan: "basic",
    ai_reset_at: new Date("2026-03-01T00:00:00.000Z"),
    ai_blocked: false,
    created_at: new Date("2026-01-01"),
    description: null,
    street_address: null,
    address_notes: null,
    timezone: "America/Argentina/Buenos_Aires",
    is_active: true,
    currency_code: "ARS",
    latitude: null,
    longitude: null,
    billing_mode: "subscription",
    slug: null,
    features: {},
    ...overrides,
  } as business;
}

function buildSubscription(overrides: Partial<subscription> = {}): subscription {
  return {
    id: "sub-1",
    business_id: "biz-1",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_stripe_1",
    stripe_price_id: "price_1",
    status: "active",
    cancel_at_period_end: false,
    current_period_start: new Date("2026-03-01T00:00:00.000Z"),
    current_period_end: new Date("2026-04-01T00:00:00.000Z"),
    created_at: new Date("2026-01-01"),
    updated_at: new Date("2026-01-01"),
    plan_id: null,
    is_trial: false,
    trial_end: null,
    ...overrides,
  } as subscription;
}

describe("evaluateBusinessBillingAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bloquea sin fila subscription", async () => {
    mockedFindSubscription.mockResolvedValue(null);
    const result = await evaluateBusinessBillingAccess(buildBusiness());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(BILLING_ACCESS_MESSAGES.noSubscription);
    }
  });

  it("bloquea trial vencido por fecha", async () => {
    mockedFindSubscription.mockResolvedValue(
      buildSubscription({
        status: "trialing",
        is_trial: true,
        trial_end: new Date("2020-01-01"),
      })
    );
    const result = await evaluateBusinessBillingAccess(buildBusiness());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(BILLING_ACCESS_MESSAGES.trialDateEnded);
    }
  });

  it("bloquea trial con tokens agotados", async () => {
    mockedFindSubscription.mockResolvedValue(
      buildSubscription({
        status: "trialing",
        is_trial: true,
        trial_end: new Date("2099-01-01"),
      })
    );
    const result = await evaluateBusinessBillingAccess(
      buildBusiness({ ai_monthly_tokens_used: 100_000 })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(BILLING_ACCESS_MESSAGES.trialTokensExhausted);
    }
  });

  it("bloquea status canceled", async () => {
    mockedFindSubscription.mockResolvedValue(
      buildSubscription({ status: "canceled" })
    );
    const result = await evaluateBusinessBillingAccess(buildBusiness());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(BILLING_ACCESS_MESSAGES.inactive);
    }
  });

  it("bloquea past_due", async () => {
    mockedFindSubscription.mockResolvedValue(
      buildSubscription({ status: "past_due" })
    );
    const result = await evaluateBusinessBillingAccess(buildBusiness());
    expect(result.ok).toBe(false);
  });

  it("permite trial vigente", async () => {
    mockedFindSubscription.mockResolvedValue(
      buildSubscription({
        status: "trialing",
        is_trial: true,
        trial_end: new Date("2099-01-01"),
        stripe_customer_id: null,
        stripe_subscription_id: null,
      })
    );
    const result = await evaluateBusinessBillingAccess(buildBusiness());
    expect(result.ok).toBe(true);
  });

  it("permite active", async () => {
    mockedFindSubscription.mockResolvedValue(buildSubscription());
    const result = await evaluateBusinessBillingAccess(buildBusiness());
    expect(result.ok).toBe(true);
  });
});

describe("evaluateSubscriptionRowAccess", () => {
  it("reporta no_subscription", () => {
    expect(evaluateSubscriptionRowAccess(buildBusiness(), null)).toEqual({
      access_ok: false,
      reason: "no_subscription",
    });
  });
});
