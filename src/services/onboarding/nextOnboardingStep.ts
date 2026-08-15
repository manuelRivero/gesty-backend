/**
 * Fuente de verdad determinística del paso de onboarding.
 * Orden de Facts (agent-factory / OWNERSHIP-ENTRY D1-B):
 *   capture → confirm → name → done
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
  if (!state.hasSavedAddress) {
    if (state.stagedAddress) return 'confirm';
    return 'capture';
  }
  if (!state.hasCustomerName) return 'name';
  return 'done';
}
