/**
 * Fuente de verdad determinística del paso de onboarding.
 * Orden de Facts: name → capture → confirm → done
 * (nombre primero; dirección después, omitible vía finish_onboarding).
 */

export type OnboardingStep = 'capture' | 'confirm' | 'name' | 'done';

export interface OnboardingStepState {
  hasSavedAddress: boolean;
  /** Nombre en BD (`customer.name`), no el perfil de WhatsApp. */
  hasCustomerName: boolean;
  /** `temp_address` con `onboarding_step === 'CONFIRM'`, o `null` si no hay staging. */
  stagedAddress: string | null;
}

export function nextOnboardingStep(state: OnboardingStepState): OnboardingStep {
  if (!state.hasCustomerName) return 'name';
  if (!state.hasSavedAddress) {
    if (state.stagedAddress) return 'confirm';
    return 'capture';
  }
  return 'done';
}
