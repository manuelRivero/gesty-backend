/**
 * Tests del resume de onboarding tras `delegate_to_main` (P0.3/H-B): el
 * follow-up debe reflejar el paso derivado, no una frase fija que ignore si
 * había una dirección staged pendiente de confirmar.
 */

import { describe, expect, it } from 'vitest';
import { buildResumeFollowUp } from '../buildResumeFollowUp';

describe('buildResumeFollowUp (kind: onboarding)', () => {
  it('paso capture → pide la dirección desde cero', () => {
    const resume = buildResumeFollowUp({
      kind: 'onboarding',
      step: 'capture',
      stagedAddress: null,
    });
    expect(resume.text).toContain('decime tu dirección');
    expect(resume.onboardingStagedAddress).toBeUndefined();
  });

  it('paso confirm con dirección staged → retoma la confirmación de ESA dirección', () => {
    const resume = buildResumeFollowUp({
      kind: 'onboarding',
      step: 'confirm',
      stagedAddress: 'Calle Falsa 123',
    });
    expect(resume.text).toContain('Calle Falsa 123');
    expect(resume.text).not.toContain('decime tu dirección');
    expect(resume.onboardingStagedAddress).toBe('Calle Falsa 123');
  });

  it('paso name → pide el nombre', () => {
    const resume = buildResumeFollowUp({
      kind: 'onboarding',
      step: 'name',
      stagedAddress: null,
    });
    expect(resume.text).toContain('nombre');
    expect(resume.onboardingStagedAddress).toBeUndefined();
  });

  it('paso done → no anexa nada (la sesión ya no está en onboarding)', () => {
    const resume = buildResumeFollowUp({
      kind: 'onboarding',
      step: 'done',
      stagedAddress: null,
    });
    expect(resume.text).toBeNull();
    expect(resume.onboardingStagedAddress).toBeUndefined();
  });
});
