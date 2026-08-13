/**
 * Identidad del dueño en WhatsApp. Función pura: es el equivalente de
 * `nextXStep` para un agente que no recolecta Facts (PLAN-ACCION-OWNER-ASSISTANT.md).
 *
 * Matching por dígitos, fail closed (lista vacía → nadie).
 */

export const normalizePhoneDigits = (phone: string): string =>
  phone.replace(/\D/g, '');

export const sanitizeOwnerPhones = (phones: readonly string[]): string[] => {
  if (!Array.isArray(phones)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of phones) {
    if (typeof raw !== 'string') continue;
    const digits = normalizePhoneDigits(raw);
    if (digits.length < 8 || digits.length > 15) continue;
    if (seen.has(digits)) continue;
    seen.add(digits);
    out.push(digits);
  }
  return out;
};

export const isOwnerPhone = (
  incoming: string | null | undefined,
  allowlist: readonly string[] | null | undefined
): boolean => {
  const incomingDigits = incoming ? normalizePhoneDigits(incoming) : '';
  if (!incomingDigits) return false;
  const allowed = sanitizeOwnerPhones(allowlist ?? []);
  if (allowed.length === 0) return false;
  return allowed.includes(incomingDigits);
};
