/**
 * Fuente de verdad determinística del paso de onboarding (P0.2 de
 * `PLAN-ACCION-ONBOARDING-AUTONOMIA.md`, D3), mismo rol que `nextCheckoutStep`
 * para el checkout: función pura sobre Facts ya cargados, sin BD ni metadata,
 * usada como única fuente para el ledger del prompt, el resume tras
 * `delegate_to_main` y el fallback de cuerpo del nodo.
 */

export type OnboardingStep = 'capture' | 'confirm' | 'done';

export interface OnboardingStepState {
  hasSavedAddress: boolean;
  /** `temp_address` con `onboarding_step === 'CONFIRM'`, o `null` si no hay staging. */
  stagedAddress: string | null;
}

export function nextOnboardingStep(state: OnboardingStepState): OnboardingStep {
  if (state.hasSavedAddress) return 'done';
  if (state.stagedAddress) return 'confirm';
  return 'capture';
}
