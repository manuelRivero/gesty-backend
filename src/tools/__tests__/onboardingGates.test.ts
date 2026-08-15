/**
 * Gates de onboarding (withGate): bloqueo sin efecto; happy path mockeado.
 * Sin regex sobre mensajes del usuario.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/onboarding/loadLiveOnboardingFacts', () => ({
  loadLiveOnboardingFacts: vi.fn(),
}));

vi.mock('../../services/address.service', () => ({
  AddressService: class {
    resolveAndStageAddress = vi.fn().mockResolvedValue({
      status: 'in_coverage',
      formattedAddress: 'Calle Falsa 123',
    });
  },
}));

vi.mock('../../repositories/customer.repository', () => ({
  updateCustomerName: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../repositories/conversationState.repository', () => ({
  omitConversationMetadataKeys: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/intent/intentRefusal.service', () => ({
  incrementRefusalCount: vi.fn().mockResolvedValue(1),
}));

import { loadLiveOnboardingFacts } from '../../services/onboarding/loadLiveOnboardingFacts';
import {
  checkAddressCoverageTool,
  resolveAddressConfirmationTool,
  saveCustomerNameOnboardingTool,
} from '../onboarding';
import { updateCustomerName } from '../../repositories/customer.repository';
import type { OnboardingStepState } from '../../services/onboarding/nextOnboardingStep';

const config = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: '2026-01-01T00:00:00.000Z',
  },
};

const facts = (overrides: Partial<OnboardingStepState> = {}): OnboardingStepState => ({
  hasSavedAddress: false,
  hasCustomerName: false,
  stagedAddress: null,
  ...overrides,
});

describe('onboarding tool gates (withGate)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('check_address_coverage bloquea si el paso no es capture', async () => {
    vi.mocked(loadLiveOnboardingFacts).mockResolvedValue(
      facts({ hasSavedAddress: true, hasCustomerName: false })
    );
    const out = JSON.parse(
      await checkAddressCoverageTool.func({ text: 'Calle 1' }, undefined, config)
    );
    expect(out).toEqual({ error: 'name_required', missing: 'name' });
  });

  it('check_address_coverage permite en capture', async () => {
    vi.mocked(loadLiveOnboardingFacts).mockResolvedValue(facts());
    const out = JSON.parse(
      await checkAddressCoverageTool.func({ text: 'Calle 1' }, undefined, config)
    );
    expect(out.status).toBe('in_coverage');
  });

  it('resolve_address_confirmation bloquea si el paso no es confirm', async () => {
    vi.mocked(loadLiveOnboardingFacts).mockResolvedValue(facts());
    const out = JSON.parse(
      await resolveAddressConfirmationTool.func({ confirmed: true }, undefined, config)
    );
    expect(out).toEqual({ error: 'capture_required', missing: 'capture' });
  });

  it('save_customer_name bloquea si el paso no es name', async () => {
    vi.mocked(loadLiveOnboardingFacts).mockResolvedValue(facts());
    const out = JSON.parse(
      await saveCustomerNameOnboardingTool.func({ name: 'Ana' }, undefined, config)
    );
    expect(out).toEqual({ error: 'capture_required', missing: 'capture' });
    expect(updateCustomerName).not.toHaveBeenCalled();
  });

  it('save_customer_name persiste en paso name', async () => {
    vi.mocked(loadLiveOnboardingFacts).mockResolvedValue(
      facts({ hasSavedAddress: true, hasCustomerName: false })
    );
    const out = JSON.parse(
      await saveCustomerNameOnboardingTool.func({ name: 'Ana' }, undefined, config)
    );
    expect(out).toEqual({
      success: true,
      name: 'Ana',
      signal: 'onboarding_profile_complete',
    });
    expect(updateCustomerName).toHaveBeenCalledWith('cust-1', 'Ana');
  });
});
