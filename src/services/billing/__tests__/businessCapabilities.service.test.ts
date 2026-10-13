import { describe, expect, it, vi } from 'vitest';
import type { business, plan } from '@prisma/client';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    business: {
      findUnique: vi.fn(),
    },
    subscription: {
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from '../../../lib/prisma';
import {
  decideAiCapability,
  decideShoppingCapability,
  resolveBusinessCapabilities,
  type SubscriptionForCapabilities,
} from '../businessCapabilities.service';

const mockedFindBusiness = prisma.business.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedFindSubscription = prisma.subscription.findUnique as unknown as ReturnType<
  typeof vi.fn
>;

function buildBusiness(overrides: Partial<business> = {}): business {
  return {
    id: 'biz-1',
    name: 'Test',
    ai_monthly_tokens_used: 1_000,
    ai_monthly_token_limit: 100_000,
    ai_plan: 'basic',
    ai_reset_at: new Date('2026-03-01T00:00:00.000Z'),
    ai_blocked: false,
    created_at: new Date('2026-01-01'),
    description: null,
    street_address: null,
    address_notes: null,
    timezone: 'America/Argentina/Buenos_Aires',
    is_active: true,
    currency_code: 'ARS',
    latitude: null,
    longitude: null,
    billing_mode: 'subscription',
    slug: null,
    category: null,
    features: {},
    openai_api_key: null,
    openai_model: null,
    openai_active: true,
    whatsapp_phone_number: null,
    whatsapp_phone_id: null,
    whatsapp_access_token: null,
    ...overrides,
  } as business;
}

function buildPlan(overrides: Partial<plan> = {}): Pick<plan, 'ai_enabled' | 'shopping_enabled'> {
  return {
    ai_enabled: true,
    shopping_enabled: true,
    ...overrides,
  };
}

function buildSub(
  overrides: Partial<SubscriptionForCapabilities> = {}
): SubscriptionForCapabilities {
  return {
    status: 'active',
    is_trial: false,
    trial_end: null,
    cancel_at_period_end: false,
    current_period_end: new Date('2099-01-01'),
    plan_id: 'plan-1',
    plan: buildPlan(),
    ...overrides,
  };
}

describe('decideShoppingCapability (pure)', () => {
  it('denies without a subscription', () => {
    expect(decideShoppingCapability(null)).toEqual({ allowed: false, reason: 'no_subscription' });
  });

  it('allows a valid trial without a plan', () => {
    const sub = buildSub({ is_trial: true, status: 'trialing', plan_id: null, plan: null });
    expect(decideShoppingCapability(sub)).toEqual({ allowed: true, reason: 'trial' });
  });

  it('denies an expired trial', () => {
    const sub = buildSub({
      is_trial: true,
      status: 'trialing',
      trial_end: new Date('2020-01-01'),
      plan_id: null,
      plan: null,
    });
    expect(decideShoppingCapability(sub)).toEqual({ allowed: false, reason: 'trial_ended' });
  });

  it('denies a paid subscription with plan_id=null (unresolved plan)', () => {
    const sub = buildSub({ plan_id: null, plan: null });
    expect(decideShoppingCapability(sub)).toEqual({ allowed: false, reason: 'plan_unresolved' });
  });

  it('denies an inactive-status subscription even with shopping_enabled plan', () => {
    const sub = buildSub({ status: 'past_due' });
    expect(decideShoppingCapability(sub)).toEqual({ allowed: false, reason: 'inactive' });
  });

  it('allows a Shopping Only plan (shopping_enabled=true, ai_enabled=false)', () => {
    const sub = buildSub({ plan: buildPlan({ ai_enabled: false, shopping_enabled: true }) });
    expect(decideShoppingCapability(sub)).toEqual({ allowed: true, reason: 'ok' });
  });

  it('denies a plan with shopping_enabled=false', () => {
    const sub = buildSub({ plan: buildPlan({ shopping_enabled: false }) });
    expect(decideShoppingCapability(sub)).toEqual({
      allowed: false,
      reason: 'plan_shopping_disabled',
    });
  });

  it('honors cancel_at_period_end until current_period_end', () => {
    const futureSub = buildSub({
      cancel_at_period_end: true,
      current_period_end: new Date(Date.now() + 86_400_000),
    });
    expect(decideShoppingCapability(futureSub)).toEqual({ allowed: true, reason: 'ok' });

    const pastSub = buildSub({
      cancel_at_period_end: true,
      current_period_end: new Date(Date.now() - 86_400_000),
    });
    expect(decideShoppingCapability(pastSub)).toEqual({ allowed: false, reason: 'period_ended' });
  });
});

describe('decideAiCapability (pure)', () => {
  const noExtra = { aiBlocked: false, trialTokensExhausted: false };

  it('denies without a subscription', () => {
    expect(decideAiCapability(null, noExtra)).toEqual({
      allowed: false,
      reason: 'no_subscription',
    });
  });

  it('denies a Shopping Only plan even with ai_plan/ai_blocked implying otherwise', () => {
    const sub = buildSub({ plan: buildPlan({ ai_enabled: false, shopping_enabled: true }) });
    // ai_blocked=false (not manually blocked) must NOT translate into allowed=true.
    expect(decideAiCapability(sub, noExtra)).toEqual({
      allowed: false,
      reason: 'plan_ai_disabled',
    });
  });

  it('allows a plan with ai_enabled=true', () => {
    const sub = buildSub();
    expect(decideAiCapability(sub, noExtra)).toEqual({ allowed: true, reason: 'ok' });
  });

  it('ai_blocked=true denies AI even when the plan enables it (operator override, never grants)', () => {
    const sub = buildSub();
    expect(decideAiCapability(sub, { ...noExtra, aiBlocked: true })).toEqual({
      allowed: false,
      reason: 'ai_blocked',
    });
  });

  it('allows a valid trial without a plan, subject to token exhaustion', () => {
    const sub = buildSub({ is_trial: true, status: 'trialing', plan_id: null, plan: null });
    expect(decideAiCapability(sub, noExtra)).toEqual({ allowed: true, reason: 'trial' });
    expect(decideAiCapability(sub, { ...noExtra, trialTokensExhausted: true })).toEqual({
      allowed: false,
      reason: 'trial_tokens',
    });
  });

  it('denies an expired trial regardless of ai_blocked/tokens', () => {
    const sub = buildSub({
      is_trial: true,
      status: 'trialing',
      trial_end: new Date('2020-01-01'),
      plan_id: null,
      plan: null,
    });
    expect(decideAiCapability(sub, noExtra)).toEqual({ allowed: false, reason: 'trial_ended' });
  });

  it('denies a paid subscription with unresolved plan', () => {
    const sub = buildSub({ plan_id: null, plan: null });
    expect(decideAiCapability(sub, noExtra)).toEqual({
      allowed: false,
      reason: 'plan_unresolved',
    });
  });

  it('respects cancel_at_period_end the same way as shopping', () => {
    const pastSub = buildSub({
      cancel_at_period_end: true,
      current_period_end: new Date(Date.now() - 86_400_000),
    });
    expect(decideAiCapability(pastSub, noExtra)).toEqual({
      allowed: false,
      reason: 'period_ended',
    });
  });
});

describe('resolveBusinessCapabilities (async, fail-closed)', () => {
  it('denies both when the business does not exist', async () => {
    mockedFindBusiness.mockResolvedValueOnce(null);
    const result = await resolveBusinessCapabilities('missing');
    expect(result.ai).toEqual({ allowed: false, reason: 'no_business' });
    expect(result.shopping).toEqual({ allowed: false, reason: 'no_business' });
  });

  it('denies both when there is no subscription row', async () => {
    mockedFindBusiness.mockResolvedValueOnce(buildBusiness());
    mockedFindSubscription.mockResolvedValueOnce(null);
    const result = await resolveBusinessCapabilities('biz-1');
    expect(result.ai.allowed).toBe(false);
    expect(result.shopping.allowed).toBe(false);
  });

  it('grants shopping only (not AI) for a Shopping Only plan with an active subscription', async () => {
    mockedFindBusiness.mockResolvedValueOnce(buildBusiness());
    mockedFindSubscription.mockResolvedValueOnce({
      id: 'sub-1',
      plan_id: 'plan-shopping-only',
      status: 'active',
      is_trial: false,
      trial_end: null,
      cancel_at_period_end: false,
      current_period_end: new Date('2099-01-01'),
      plan: buildPlan({ ai_enabled: false, shopping_enabled: true }),
    });
    const result = await resolveBusinessCapabilities('biz-1');
    expect(result.ai).toEqual({ allowed: false, reason: 'plan_ai_disabled' });
    expect(result.shopping).toEqual({ allowed: true, reason: 'ok' });
  });

  it('grants both for a plan with AI + Shopping enabled (no regression for existing plans)', async () => {
    mockedFindBusiness.mockResolvedValueOnce(buildBusiness());
    mockedFindSubscription.mockResolvedValueOnce({
      id: 'sub-1',
      plan_id: 'plan-basic',
      status: 'active',
      is_trial: false,
      trial_end: null,
      cancel_at_period_end: false,
      current_period_end: new Date('2099-01-01'),
      plan: buildPlan(),
    });
    const result = await resolveBusinessCapabilities('biz-1');
    expect(result.ai.allowed).toBe(true);
    expect(result.shopping.allowed).toBe(true);
  });

  it('denies AI via ai_blocked even though the plan enables it (operator block cannot be bypassed)', async () => {
    mockedFindBusiness.mockResolvedValueOnce(buildBusiness({ ai_blocked: true }));
    mockedFindSubscription.mockResolvedValueOnce({
      id: 'sub-1',
      plan_id: 'plan-basic',
      status: 'active',
      is_trial: false,
      trial_end: null,
      cancel_at_period_end: false,
      current_period_end: new Date('2099-01-01'),
      plan: buildPlan(),
    });
    const result = await resolveBusinessCapabilities('biz-1');
    expect(result.ai).toEqual({ allowed: false, reason: 'ai_blocked' });
    expect(result.shopping.allowed).toBe(true);
  });

  it('denies both on an active subscription with an unresolved plan (plan_id set, plan null)', async () => {
    mockedFindBusiness.mockResolvedValueOnce(buildBusiness());
    mockedFindSubscription.mockResolvedValueOnce({
      id: 'sub-1',
      plan_id: 'deleted-plan',
      status: 'active',
      is_trial: false,
      trial_end: null,
      cancel_at_period_end: false,
      current_period_end: new Date('2099-01-01'),
      plan: null,
    });
    const result = await resolveBusinessCapabilities('biz-1');
    expect(result.ai).toEqual({ allowed: false, reason: 'plan_unresolved' });
    expect(result.shopping).toEqual({ allowed: false, reason: 'plan_unresolved' });
  });

  it('fails closed (denies both) on a database error', async () => {
    mockedFindBusiness.mockRejectedValueOnce(new Error('db down'));
    const result = await resolveBusinessCapabilities('biz-1');
    expect(result.ai).toEqual({ allowed: false, reason: 'resolution_error' });
    expect(result.shopping).toEqual({ allowed: false, reason: 'resolution_error' });
  });

  it('grants both for a valid trial without plan_id', async () => {
    mockedFindBusiness.mockResolvedValueOnce(buildBusiness({ ai_monthly_tokens_used: 10 }));
    mockedFindSubscription.mockResolvedValueOnce({
      id: 'sub-1',
      plan_id: null,
      status: 'trialing',
      is_trial: true,
      trial_end: new Date(Date.now() + 86_400_000),
      cancel_at_period_end: false,
      current_period_end: new Date('2099-01-01'),
      plan: null,
    });
    const result = await resolveBusinessCapabilities('biz-1');
    expect(result.ai.allowed).toBe(true);
    expect(result.shopping.allowed).toBe(true);
  });

  it('denies AI (not shopping) when trial tokens are exhausted', async () => {
    mockedFindBusiness.mockResolvedValueOnce(
      buildBusiness({ ai_monthly_tokens_used: 999_999, ai_monthly_token_limit: 1_000 })
    );
    mockedFindSubscription.mockResolvedValueOnce({
      id: 'sub-1',
      plan_id: null,
      status: 'trialing',
      is_trial: true,
      trial_end: new Date(Date.now() + 86_400_000),
      cancel_at_period_end: false,
      current_period_end: new Date('2099-01-01'),
      plan: null,
    });
    const result = await resolveBusinessCapabilities('biz-1');
    expect(result.ai).toEqual({ allowed: false, reason: 'trial_tokens' });
    expect(result.shopping.allowed).toBe(true);
  });
});
