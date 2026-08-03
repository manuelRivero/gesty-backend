/**
 * Detección del código de Embajador de Domingo Sabrosón en el texto del
 * mensaje inicial de WhatsApp. La landing pública (`/r/{publicCode}`) arma un
 * link `wa.me` cuyo texto prellenado contiene `DS_REF=AMB-XXXXXX`, potencialmente
 * junto a otro texto agregado por WhatsApp o el propio cliente.
 */

/** TTL de la referencia temporal en `conversation_state.metadata.ambassador_ref`. */
export const AMBASSADOR_REF_TTL_MS = 24 * 60 * 60 * 1000;

const REFERRAL_PATTERN = /DS_REF\s*[=:]\s*(AMB-[A-Z0-9]+)/i;

export type ExtractedReferral = {
  /** Código normalizado a mayúsculas, ej. `AMB-7F3K9X`. */
  code: string;
  /** Texto original sin el token `DS_REF=...` (ni espacios sobrantes). */
  sanitizedText: string;
};

/**
 * Busca `DS_REF=AMB-XXXXXX` (o `DS_REF:AMB-XXXXXX`) en `text`. Si hay match,
 * devuelve el código normalizado y el texto sin el token, para que el resto
 * del pipeline (NLP, agentes) nunca vea el identificador técnico.
 */
export const extractReferralCode = (
  text: string | null | undefined
): ExtractedReferral | null => {
  if (!text) return null;

  const match = REFERRAL_PATTERN.exec(text);
  if (!match) return null;

  const code = match[1].toUpperCase();
  const sanitizedText = text.replace(match[0], '').trim();

  return { code, sanitizedText };
};

export const isAmbassadorRefExpired = (
  validatedAt: string,
  now: Date = new Date()
): boolean => {
  const validatedAtMs = new Date(validatedAt).getTime();
  if (!Number.isFinite(validatedAtMs)) return true;
  return now.getTime() - validatedAtMs > AMBASSADOR_REF_TTL_MS;
};
