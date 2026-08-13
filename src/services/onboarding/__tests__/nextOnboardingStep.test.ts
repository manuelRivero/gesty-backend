import { describe, expect, it } from 'vitest';
import { nextOnboardingStep } from '../nextOnboardingStep';
import type { OnboardingStepState } from '../nextOnboardingStep';

const state = (overrides: Partial<OnboardingStepState> = {}): OnboardingStepState => ({
  hasSavedAddress: false,
  stagedAddress: null,
  ...overrides,
});

describe('nextOnboardingStep', () => {
  it('sin dirección guardada ni staged → capture', () => {
    expect(nextOnboardingStep(state())).toBe('capture');
  });

  it('con dirección staged (CONFIRM) y sin guardar → confirm', () => {
    expect(nextOnboardingStep(state({ stagedAddress: 'Calle Falsa 123' }))).toBe('confirm');
  });

  it('con dirección guardada → done, sin importar el staging', () => {
    expect(
      nextOnboardingStep(state({ hasSavedAddress: true, stagedAddress: 'Calle Falsa 123' }))
    ).toBe('done');
    expect(nextOnboardingStep(state({ hasSavedAddress: true }))).toBe('done');
  });
});
