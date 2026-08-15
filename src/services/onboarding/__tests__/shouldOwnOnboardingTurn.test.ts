import { describe, expect, it } from 'vitest';
import {
  shouldOwnOnboardingTurn,
  type ShouldOwnOnboardingTurnInput,
} from '../shouldOwnOnboardingTurn';

const base = (
  overrides: Partial<ShouldOwnOnboardingTurnInput> = {}
): ShouldOwnOnboardingTurnInput => ({
  hasUsableDefaultAddress: false,
  hasCustomerName: false,
  addressRefusalCount: 0,
  nameRefusalCount: 0,
  onboardingAgentActive: false,
  hasStagedOnboarding: false,
  isOnboardingPayload: false,
  blockedByHigherOwner: false,
  ...overrides,
});

describe('shouldOwnOnboardingTurn', () => {
  it('wipe / sin dirección ni nombre, refusal 0 → facts_missing_name (nombre primero)', () => {
    expect(shouldOwnOnboardingTurn(base())).toEqual({
      shouldOwn: true,
      reason: 'facts_missing_name',
    });
  });

  it('con nombre, sin dirección, refusal dirección 0 → facts_missing_address', () => {
    expect(
      shouldOwnOnboardingTurn(base({ hasCustomerName: true, hasUsableDefaultAddress: false }))
    ).toEqual({
      shouldOwn: true,
      reason: 'facts_missing_address',
    });
  });

  it('con dirección, sin nombre, refusal nombre 0 → facts_missing_name', () => {
    expect(
      shouldOwnOnboardingTurn(base({ hasUsableDefaultAddress: true, hasCustomerName: false }))
    ).toEqual({
      shouldOwn: true,
      reason: 'facts_missing_name',
    });
  });

  it('perfil completo → skipped_profile_complete', () => {
    expect(
      shouldOwnOnboardingTurn(
        base({ hasUsableDefaultAddress: true, hasCustomerName: true })
      )
    ).toEqual({
      shouldOwn: false,
      reason: 'skipped_profile_complete',
    });
  });

  it('tras name_refused sin dirección → no reentra por Facts de nombre', () => {
    expect(
      shouldOwnOnboardingTurn(
        base({
          hasUsableDefaultAddress: false,
          hasCustomerName: false,
          nameRefusalCount: 1,
        })
      )
    ).toEqual({
      shouldOwn: false,
      reason: 'skipped_refusal',
    });
  });

  it('tras address_refused con nombre → no reentra por Facts de dirección', () => {
    expect(
      shouldOwnOnboardingTurn(
        base({
          hasCustomerName: true,
          hasUsableDefaultAddress: false,
          addressRefusalCount: 1,
        })
      )
    ).toEqual({
      shouldOwn: false,
      reason: 'skipped_refusal',
    });
  });

  it('checkout / dueño superior → skipped_higher_owner', () => {
    expect(shouldOwnOnboardingTurn(base({ blockedByHigherOwner: true }))).toEqual({
      shouldOwn: false,
      reason: 'skipped_higher_owner',
    });
  });

  it('sesión activa con perfil completo (edge) → session_active', () => {
    expect(
      shouldOwnOnboardingTurn(
        base({
          onboardingAgentActive: true,
          hasUsableDefaultAddress: true,
          hasCustomerName: true,
        })
      )
    ).toEqual({
      shouldOwn: true,
      reason: 'session_active',
    });
  });

  it('payload abre sesión', () => {
    expect(
      shouldOwnOnboardingTurn(
        base({
          isOnboardingPayload: true,
          hasUsableDefaultAddress: true,
          hasCustomerName: true,
        })
      )
    ).toEqual({
      shouldOwn: true,
      reason: 'payload',
    });
  });
});
