import { beforeEach, describe, expect, it, vi } from "vitest";
import type { business, subscription } from "@prisma/client";

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    business: {
      findUnique: vi.fn(),
      update: vi.fn()
    },
    subscription: {
      findUnique: vi.fn()
    }
  }
}));

vi.mock("../../ai/aiUsage.service", () => ({
  resetIfNeeded: vi.fn(async (b: business) => b)
}));

import { prisma } from "../../../lib/prisma";
import {
  buildBusinessAiQuotaDto,
  getBusinessAiQuota,
  isActiveSubscription
} from "../businessAiQuota.service";

const mockedFindBusiness = prisma.business.findUnique as unknown as ReturnType<
  typeof vi.fn
>;
const mockedFindSubscription = prisma.subscription.findUnique as unknown as ReturnType<
  typeof vi.fn
>;

function buildBusiness(overrides: Partial<business> = {}): business {
  return {
    id: "biz-1",
    name: "Test",
    ai_monthly_tokens_used: 25_000,
    ai_monthly_token_limit: 100_000,
    ai_plan: "basic",
    ai_reset_at: new Date("2026-03-01T00:00:00.000Z"),
    ai_blocked: false,
    created_at: new Date("2026-01-01"),
    updated_at: new Date("2026-01-01"),
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
    ...overrides
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
    ...overrides
  } as subscription;
}

describe("businessAiQuota.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isActiveSubscription", () => {
    it("acepta suscripciones activas y en trial vigente", () => {
      expect(isActiveSubscription(buildSubscription({ status: "active" }))).toBe(true);
      expect(
        isActiveSubscription(
          buildSubscription({
            status: "trialing",
            is_trial: true,
            trial_end: new Date("2099-01-01")
          })
        )
      ).toBe(true);
    });

    it("rechaza estados inactivos o trial vencido", () => {
      expect(isActiveSubscription(buildSubscription({ status: "past_due" }))).toBe(false);
      expect(isActiveSubscription(buildSubscription({ status: "canceled" }))).toBe(false);
      expect(
        isActiveSubscription(
          buildSubscription({
            status: "trialing",
            is_trial: true,
            trial_end: new Date("2020-01-01")
          })
        )
      ).toBe(false);
    });
  });

  describe("buildBusinessAiQuotaDto", () => {
    it("calcula tokens restantes y has_quota", () => {
      const dto = buildBusinessAiQuotaDto(
        buildBusiness({ ai_monthly_tokens_used: 40_000, ai_monthly_token_limit: 100_000 }),
        buildSubscription()
      );

      expect(dto).toMatchObject({
        tokens_used: 40_000,
        tokens_limit: 100_000,
        tokens_remaining: 60_000,
        has_quota: true,
        ai_blocked: false
      });
    });

    it("marca has_quota en false cuando está bloqueado o sin cupo", () => {
      const blocked = buildBusinessAiQuotaDto(
        buildBusiness({ ai_blocked: true }),
        buildSubscription()
      );
      const exhausted = buildBusinessAiQuotaDto(
        buildBusiness({ ai_monthly_tokens_used: 100_000, ai_monthly_token_limit: 100_000 }),
        buildSubscription()
      );

      expect(blocked.has_quota).toBe(false);
      expect(exhausted.has_quota).toBe(false);
      expect(exhausted.tokens_remaining).toBe(0);
    });
  });

  describe("getBusinessAiQuota", () => {
    it("devuelve access_ok false si no hay suscripción activa", async () => {
      mockedFindBusiness.mockResolvedValue(buildBusiness());
      mockedFindSubscription.mockResolvedValue(
        buildSubscription({ status: "canceled" })
      );

      const quota = await getBusinessAiQuota("biz-1");
      expect(quota).toMatchObject({
        access_ok: false,
        requires_subscription: true,
        subscription: { status: "canceled" },
      });
    });

    it("devuelve access_ok false y subscription null sin fila", async () => {
      mockedFindBusiness.mockResolvedValue(buildBusiness());
      mockedFindSubscription.mockResolvedValue(null);

      const quota = await getBusinessAiQuota("biz-1");
      expect(quota).toMatchObject({
        access_ok: false,
        subscription: null,
        tokens_used: 25_000,
      });
    });

    it("en trial manual expone plan Trial aunque ai_plan en BD sea basic", async () => {
      mockedFindBusiness.mockResolvedValue(buildBusiness({ ai_plan: "basic" }));
      mockedFindSubscription.mockResolvedValue(
        buildSubscription({
          is_trial: true,
          status: "trialing",
          stripe_subscription_id: null,
          stripe_customer_id: null,
          trial_end: new Date("2099-01-01"),
        })
      );

      const quota = await getBusinessAiQuota("biz-1");
      expect(quota?.subscription).toMatchObject({
        is_trial: true,
        plan_name: "Trial",
      });
    });

    it("devuelve el snapshot cuando la suscripción está activa", async () => {
      mockedFindBusiness.mockResolvedValue(
        buildBusiness({ ai_monthly_tokens_used: 10_000 })
      );
      mockedFindSubscription.mockResolvedValue(buildSubscription());

      const quota = await getBusinessAiQuota("biz-1");

      expect(quota).toMatchObject({
        tokens_used: 10_000,
        tokens_remaining: 90_000,
        access_ok: true,
        subscription: {
          status: "active",
          plan_name: "Basic"
        }
      });
    });
  });
});
