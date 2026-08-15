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
  it('sin dirección ni staged → capture', () => {
    expect(nextOnboardingStep(state())).toBe('capture');
  });

  it('con dirección staged y sin guardar → confirm', () => {
    expect(nextOnboardingStep(state({ stagedAddress: 'Calle Falsa 123' }))).toBe('confirm');
  });

  it('con dirección guardada y sin nombre → name', () => {
    expect(nextOnboardingStep(state({ hasSavedAddress: true }))).toBe('name');
  });

  it('con dirección y nombre → done (staging no importa)', () => {
    expect(
      nextOnboardingStep(
        state({
          hasSavedAddress: true,
          hasCustomerName: true,
          stagedAddress: 'Calle Falsa 123',
        })
      )
    ).toBe('done');
  });

  it('dirección guardada gana sobre staging → name si falta nombre', () => {
    expect(
      nextOnboardingStep(
        state({ hasSavedAddress: true, hasCustomerName: false, stagedAddress: 'X' })
      )
    ).toBe('name');
  });
});
