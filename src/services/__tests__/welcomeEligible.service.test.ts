import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../repositories', () => ({
  patchConversationMetadata: vi.fn().mockResolvedValue(undefined),
  omitConversationMetadataKeys: vi.fn().mockResolvedValue(undefined),
}));

import {
  patchConversationMetadata,
  omitConversationMetadataKeys,
} from '../../repositories';
import {
  buildWelcomeEligibleContextLines,
  clearWelcomeEligible,
  isWelcomeEligible,
  isWelcomeEligibleGreeting,
  setWelcomeEligible,
} from '../welcomeEligible.service';

describe('welcomeEligible.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('isWelcomeEligible / set / clear', async () => {
    expect(isWelcomeEligible({})).toBe(false);
    expect(isWelcomeEligible({ welcomeEligible: true })).toBe(true);
    await setWelcomeEligible('conv-1');
    expect(patchConversationMetadata).toHaveBeenCalledWith('conv-1', {
      welcomeEligible: true,
    });
    await clearWelcomeEligible('conv-1');
    expect(omitConversationMetadataKeys).toHaveBeenCalledWith('conv-1', [
      'welcomeEligible',
    ]);
  });

  it('context lines solo con flag', () => {
    expect(buildWelcomeEligibleContextLines({})).toEqual([]);
    const lines = buildWelcomeEligibleContextLines({ welcomeEligible: true });
    expect(lines.some((l) => /welcomeEligible/i.test(l))).toBe(true);
    expect(lines.some((l) => /present_welcome_options/i.test(l))).toBe(true);
  });

  it('isWelcomeEligibleGreeting', () => {
    expect(isWelcomeEligibleGreeting('Hola buenas')).toBe(true);
    expect(isWelcomeEligibleGreeting('hola')).toBe(true);
    expect(isWelcomeEligibleGreeting('qué tal')).toBe(true);
    expect(isWelcomeEligibleGreeting('quiero ceviche')).toBe(false);
    expect(isWelcomeEligibleGreeting('mesa para 4')).toBe(false);
    expect(isWelcomeEligibleGreeting('dame el menú')).toBe(false);
  });
});
