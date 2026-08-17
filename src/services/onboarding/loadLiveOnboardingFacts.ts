/**
 * Snapshot fresco de Facts del onboarding (post tool-calls, agent-factory §3.2).
 * No usar `enrichedCtx.customer` / metadata del grafo: quedan stale si el
 * agente guardó dirección o nombre en este mismo turno.
 *
 * Alias semántico de lo que antes era solo `loadOnboardingStepState`.
 */

import { findCustomerById, findDefaultCustomerAddress } from '../../repositories/customer.repository';
import { findOrCreateConversationState } from '../../repositories';
import { normalizeMetadata } from '../productQuery/utils';
import type { OnboardingStepState } from './nextOnboardingStep';

export const loadLiveOnboardingFacts = async (params: {
  conversationId: string;
  customerId: string;
}): Promise<OnboardingStepState> => {
  const [freshState, defaultAddress, customer] = await Promise.all([
    findOrCreateConversationState(params.conversationId),
    findDefaultCustomerAddress(params.customerId),
    findCustomerById(params.customerId),
  ]);

  const meta = normalizeMetadata(freshState.metadata);
  const rawTempAddress = meta.temp_address;
  const stagedAddress =
    meta.onboarding_step === 'CONFIRM' && typeof rawTempAddress === 'string'
      ? rawTempAddress.trim() || null
      : null;

  return {
    hasSavedAddress: Boolean(defaultAddress),
    hasCustomerName: Boolean(customer?.name?.trim()),
    stagedAddress,
    addressCaptureActive: meta.onboarding_step === 'CAPTURE',
  };
};

/** @deprecated Preferí `loadLiveOnboardingFacts` (mismo contrato). */
export const loadOnboardingStepState = loadLiveOnboardingFacts;
