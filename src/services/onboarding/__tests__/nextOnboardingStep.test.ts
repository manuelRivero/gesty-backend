import { describe, expect, it } from 'vitest';
import { nextOnboardingStep } from '../nextOnboardingStep';
import type { OnboardingStepState } from '../nextOnboardingStep';

const state = (overrides: Partial<OnboardingStepState> = {}): OnboardingStepState => ({
  hasSavedAddress: false,
  hasCustomerName: false,
  stagedAddress: null,
  ...overrides,
});

describe('nextOnboardingStep', () => {
  it('sin nombre → name (aunque falte dirección)', () => {
    expect(nextOnboardingStep(state())).toBe('name');
  });

  it('con nombre, sin dirección ni staged → capture', () => {
    expect(nextOnboardingStep(state({ hasCustomerName: true }))).toBe('capture');
  });

  it('con nombre y dirección staged → confirm', () => {
    expect(
      nextOnboardingStep(
        state({ hasCustomerName: true, stagedAddress: 'Calle Falsa 123' })
      )
    ).toBe('confirm');
  });

  it('con nombre y dirección guardada → done', () => {
    expect(
      nextOnboardingStep(state({ hasCustomerName: true, hasSavedAddress: true }))
    ).toBe('done');
  });

  it('nombre primero: sin nombre ignora staging de dirección', () => {
    expect(
      nextOnboardingStep(state({ stagedAddress: 'Calle Falsa 123' }))
    ).toBe('name');
  });

  it('dirección guardada sin nombre → name', () => {
    expect(nextOnboardingStep(state({ hasSavedAddress: true }))).toBe('name');
  });
});
