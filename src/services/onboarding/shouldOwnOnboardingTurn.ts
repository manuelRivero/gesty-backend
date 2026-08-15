/**
 * Predicado puro de Ownership de onboarding (entrada + reentrada).
 *
 * Fuente: `PLAN-ACCION-ONBOARDING-OWNERSHIP-ENTRY.md` (D1-B / D2 / D4).
 * Perfil incompleto = sin dirección usable **o** sin nombre, con refusal
 * por Goal. Sesión / staging / payload siempre ganan.
 */

/** Auto-entrada por Facts solo si el contador del Goal faltante es 0. */
export const ONBOARDING_AUTO_ENTRY_MAX_REFUSAL = 0;

export type OnboardingOwnershipReason =
  | 'session_active'
  | 'payload'
  | 'staged'
  | 'facts_missing_address'
  | 'facts_missing_name'
  | 'skipped_higher_owner'
  | 'skipped_refusal'
  | 'skipped_profile_complete';

export interface ShouldOwnOnboardingTurnInput {
  hasUsableDefaultAddress: boolean;
  hasCustomerName: boolean;
  /** `getRefusalCount(..., 'OBTENER_DIRECCION')`. */
  addressRefusalCount: number;
  /** `getRefusalCount(..., 'OBTENER_NOMBRE')`. */
  nameRefusalCount: number;
  onboardingAgentActive: boolean;
  hasStagedOnboarding: boolean;
  isOnboardingPayload: boolean;
  blockedByHigherOwner: boolean;
}

export interface OnboardingOwnershipDecision {
  shouldOwn: boolean;
  reason: OnboardingOwnershipReason;
}

/**
 * Decide si el turno es del agente de onboarding.
 * Asume que el caller ya chequeó `isOnboardingAgentEnabled()`.
 */
export function shouldOwnOnboardingTurn(
  facts: ShouldOwnOnboardingTurnInput
): OnboardingOwnershipDecision {
  if (facts.blockedByHigherOwner) {
    return { shouldOwn: false, reason: 'skipped_higher_owner' };
  }

  if (facts.onboardingAgentActive) {
    return { shouldOwn: true, reason: 'session_active' };
  }

  if (facts.isOnboardingPayload) {
    return { shouldOwn: true, reason: 'payload' };
  }

  if (facts.hasStagedOnboarding) {
    return { shouldOwn: true, reason: 'staged' };
  }

  if (!facts.hasUsableDefaultAddress) {
    if (facts.addressRefusalCount > ONBOARDING_AUTO_ENTRY_MAX_REFUSAL) {
      return { shouldOwn: false, reason: 'skipped_refusal' };
    }
    return { shouldOwn: true, reason: 'facts_missing_address' };
  }

  if (!facts.hasCustomerName) {
    if (facts.nameRefusalCount > ONBOARDING_AUTO_ENTRY_MAX_REFUSAL) {
      return { shouldOwn: false, reason: 'skipped_refusal' };
    }
    return { shouldOwn: true, reason: 'facts_missing_name' };
  }

  return { shouldOwn: false, reason: 'skipped_profile_complete' };
}
