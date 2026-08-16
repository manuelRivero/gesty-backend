import { describe, expect, it } from 'vitest';
import {
  env,
  isCheckoutAgentEnabled,
  isOwnerAssistantEnabled,
  isReservationAgentEnabled,
} from '../env';

describe('flags de sesión (sin fork de producto)', () => {
  it('no exporta isHybridAgentMode ni AGENT_MODE', async () => {
    const mod = await import('../env');
    expect(mod).not.toHaveProperty('isHybridAgentMode');
    expect(env).not.toHaveProperty('AGENT_MODE');
  });

  it('isCheckoutAgentEnabled (y hermanos) solo leen su env, no un modo hybrid', () => {
    expect(isCheckoutAgentEnabled.toString()).not.toMatch(/hybrid|AGENT_MODE/i);
    expect(isReservationAgentEnabled.toString()).not.toMatch(/hybrid|AGENT_MODE/i);
    expect(isOwnerAssistantEnabled.toString()).not.toMatch(/hybrid|AGENT_MODE/i);
  });

  it('el onboarding no tiene flag: el agente es el único camino', async () => {
    const mod = await import('../env');
    expect(mod).not.toHaveProperty('isOnboardingAgentEnabled');
    expect(env).not.toHaveProperty('ONBOARDING_AGENT_ENABLED');
  });
});
