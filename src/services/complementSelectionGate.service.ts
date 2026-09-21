/**
 * Soft-gate: con ola de complemento viva, add_cart_item solo si el mensaje
 * del turno nombra un candidato (valida arg de tool; no tryHandle pre-ReAct).
 */

export function normalizeForCandidateMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9ñ\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True si el mensaje elige alguno de los nombres de la shortlist de complemento.
 */
export function userMessageSelectsCandidate(
  userMessage: string | null | undefined,
  candidateNames: string[]
): boolean {
  if (!userMessage?.trim() || candidateNames.length === 0) return false;
  const msg = normalizeForCandidateMatch(userMessage);
  if (!msg) return false;

  for (const name of candidateNames) {
    const n = normalizeForCandidateMatch(name);
    if (n.length < 3) continue;
    if (msg.includes(n)) return true;

    const tokens = n.split(' ').filter((t) => t.length >= 4);
    if (tokens.length === 0) continue;
    // Todos los tokens largos presentes, o al menos uno muy distintivo (≥5).
    if (tokens.every((t) => msg.includes(t))) return true;
    if (tokens.some((t) => t.length >= 5 && msg.includes(t))) return true;
  }
  return false;
}
