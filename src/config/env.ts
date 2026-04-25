import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(5001),
  PUBLIC_URL: z.string().optional(),
  CORS_ORIGIN: z.string().optional(),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL requerido'),

  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  PHONE_NUMBER_ID: z.string().optional(),
  WABA_ID: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_TEST_TO: z.string().optional(),

  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY requerido'),

  AGENT_MODE: z.enum(['deterministic', 'hybrid']).default('deterministic'),

  /**
   * Si `true`, los nodos `sendResponseNode` / `persistAIMessageNode` no envían a
   * la WhatsApp Cloud API ni persisten el mensaje del bot — sólo logean el
   * `HandlerResult` resultante. Pensado para los runners de paridad
   * (`scripts/parity/runner.ts`), donde queremos comparar outputs sin spamear
   * a Meta ni ensuciar la BD con mensajes de prueba.
   */
  DRY_RUN_WHATSAPP_SEND: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type AppEnv = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('[env] Variables inválidas:', z.treeifyError(parsed.error));
  throw new Error('Configuración de entorno inválida');
}

export const env: AppEnv = parsed.data;

export const isHybridAgentMode = (): boolean => env.AGENT_MODE === 'hybrid';

export const isDryRunWhatsAppSend = (): boolean =>
  env.DRY_RUN_WHATSAPP_SEND === true;
