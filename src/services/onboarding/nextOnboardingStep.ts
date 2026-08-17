/**
 * Fuente de verdad determinística del paso de onboarding.
 * Orden de Facts: name → capture → confirm → done
 * (nombre primero; dirección después, omitible vía finish_onboarding).
 *
 * Una sesión de *edición* (botón EDIT_ADDRESS / start_address_edit_session)
 * deja `onboarding_step: CAPTURE` con la dirección vieja todavía en BD.
 * Ese staging gana sobre `hasSavedAddress`: si no, el paso sale `done` y
 * `check_address_coverage` se bloquea (el cliente tipó la calle y el bot
 * pidió el nombre).
 */

export type OnboardingStep = 'capture' | 'confirm' | 'name' | 'done';

export interface OnboardingStepState {
  hasSavedAddress: boolean;
  /** Nombre en BD (`customer.name`), no el perfil de WhatsApp. */
  hasCustomerName: boolean;
  /** `temp_address` con `onboarding_step === 'CONFIRM'`, o `null` si no hay staging. */
  stagedAddress: string | null;
  /** `onboarding_step === 'CAPTURE'` (primera captura o cambio de dirección). */
  addressCaptureActive: boolean;
}

export function nextOnboardingStep(state: OnboardingStepState): OnboardingStep {
  if (!state.hasCustomerName) return 'name';
  if (state.stagedAddress) return 'confirm';
  if (state.addressCaptureActive || !state.hasSavedAddress) return 'capture';
  return 'done';
}
