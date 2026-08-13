/**
 * Carga los Facts que alimentan a `nextOnboardingStep` desde metadata fresca
 * de la conversación + BD (dirección default del cliente). Separado de
 * `nextOnboardingStep` (función pura) para que el paso derivado siga siendo
 * testeable sin BD, igual que `nextCheckoutStep`/`loadLiveCheckoutFacts`.
 */

import { findDefaultCustomerAddress } from '../../repositories/customer.repository';
import { findOrCreateConversationState } from '../../repositories';
import { normalizeMetadata } from '../productQuery/utils';
import type { OnboardingStepState } from './nextOnboardingStep';

export const loadOnboardingStepState = async (params: {
  conversationId: string;
  customerId: string;
}): Promise<OnboardingStepState> => {
  const [freshState, defaultAddress] = await Promise.all([
    findOrCreateConversationState(params.conversationId),
    findDefaultCustomerAddress(params.customerId),
  ]);

  const meta = normalizeMetadata(freshState.metadata);
  const rawTempAddress = meta.temp_address;
  const stagedAddress =
    meta.onboarding_step === 'CONFIRM' && typeof rawTempAddress === 'string'
      ? rawTempAddress.trim() || null
      : null;

  return {
    hasSavedAddress: Boolean(defaultAddress),
    stagedAddress,
  };
};
