import 'dotenv/config';

/** Variables mínimas para correr e2e contra BD + LLM reales. Requiere opt-in `E2E_RUN=1`. */
export const isE2eEnabled = (): boolean =>
  (process.env.E2E_RUN === 'true' || process.env.E2E_RUN === '1') &&
  Boolean(process.env.PHONE_NUMBER_ID?.trim()) &&
  Boolean(process.env.OPENAI_API_KEY?.trim()) &&
  Boolean(process.env.DATABASE_URL?.trim());

export const E2E_PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID ?? '';
export const E2E_CUSTOMER_PHONE = process.env.WHATSAPP_TEST_TO ?? '5493413867990';

/** Aplica flags estándar de e2e (llamar antes de importar el grafo). */
export const applyE2eEnv = (overrides?: Record<string, string>): void => {
  process.env.DRY_RUN_WHATSAPP_SEND = 'true';
  process.env.AGENT_MODE = 'hybrid';
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      process.env[key] = value;
    }
  }
};

export const e2eSkipReason = (): string | null => {
  if (process.env.E2E_RUN !== 'true' && process.env.E2E_RUN !== '1') {
    return 'E2E_RUN=1 no configurado (opt-in explícito)';
  }
  if (!process.env.DATABASE_URL?.trim()) return 'DATABASE_URL no configurado';
  if (!process.env.PHONE_NUMBER_ID?.trim()) return 'PHONE_NUMBER_ID no configurado';
  if (!process.env.OPENAI_API_KEY?.trim()) return 'OPENAI_API_KEY no configurado';
  return null;
};
