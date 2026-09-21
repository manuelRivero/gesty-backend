import { describe, it, expect } from 'vitest';
import {
  normalizeForCandidateMatch,
  userMessageSelectsCandidate,
} from '../complementSelectionGate.service';

describe('normalizeForCandidateMatch', () => {
  it('quita acentos y puntuación', () => {
    expect(normalizeForCandidateMatch('¡Chichá Morada!')).toBe('chicha morada');
  });
});

describe('userMessageSelectsCandidate', () => {
  const names = ['Chicha Morada', 'Pisco Sour', 'Suspiro a la Limeña', 'Alfajores'];

  it('true si nombra un candidato', () => {
    expect(userMessageSelectsCandidate('dame una chicha morada', names)).toBe(true);
    expect(userMessageSelectsCandidate('el pisco', names)).toBe(true);
  });

  it('false en rechazo blando / sin elección', () => {
    expect(userMessageSelectsCandidate('Estoy bien así', names)).toBe(false);
    expect(userMessageSelectsCandidate('nada más', names)).toBe(false);
    expect(userMessageSelectsCandidate('solo eso gracias', names)).toBe(false);
    expect(userMessageSelectsCandidate('', names)).toBe(false);
    expect(userMessageSelectsCandidate(null, names)).toBe(false);
  });

  it('false si la shortlist está vacía', () => {
    expect(userMessageSelectsCandidate('chicha', [])).toBe(false);
  });
});
