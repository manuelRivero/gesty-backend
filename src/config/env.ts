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
   * Habilita el ReAct agent dedicado al checkout.
   * Cuando está activo, el botón CHECKOUT inicia una "sesión de checkout"
   * gestionada por un agente especializado que valida y pide los datos
   * obligatorios (tipo de entrega, dirección, nombre) antes de cobrar.
   * Requiere AGENT_MODE=hybrid para funcionar; en caso contrario se ignora.
   */
  CHECKOUT_AGENT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  /**
   * Habilita la capa de CTA determinístico post-ReAct.
   * En false (default), runHybridReactAgent devuelve solo texto (comportamiento actual).
   */
  HYBRID_CTA_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  /**
   * Intents target para el CTA híbrido, separados por coma.
   * Default Fase 1: solo informativos. Fase 2: agregar ORDER_FOOD,RECOMMENDATION_REQUEST.
   */
  HYBRID_CTA_TARGET_INTENTS: z
    .string()
    .optional()
    .default('PRODUCT_ATTRIBUTE_QUESTION,PRODUCT_QUERY'),

  /**
   * IDs de negocio habilitados para CTA híbrido (feature flag per-business).
   * Si está vacío/undefined con HYBRID_CTA_ENABLED=true → habilitado para todos.
   */
  HYBRID_CTA_ENABLED_BUSINESS_IDS: z.string().optional(),

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

  /**
   * Clave maestra AES-256 (32 bytes en base64) para cifrar tokens de providers de pago.
   * Generar con: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   */
  PAYMENT_PROVIDER_ENCRYPTION_KEY: z.string().optional(),

  /**
   * URL base pública del servidor (para construir notification_url en Mercado Pago).
   * Ejemplo: https://mi-servidor.example.com
   */
  MERCADO_PAGO_WEBHOOK_BASE_URL: z.string().optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('[env] Variables inválidas:', z.treeifyError(parsed.error));
  throw new Error('Configuración de entorno inválida');
}

export const env: AppEnv = parsed.data;

export const isHybridAgentMode = (): boolean => env.AGENT_MODE === 'hybrid';

export const isCheckoutAgentEnabled = (): boolean =>
  isHybridAgentMode() && env.CHECKOUT_AGENT_ENABLED === true;

export const isDryRunWhatsAppSend = (): boolean =>
  env.DRY_RUN_WHATSAPP_SEND === true;

export const isHybridCtaEnabled = (): boolean =>
  env.HYBRID_CTA_ENABLED === true;

/** Devuelve el Set de ConversationIntent strings target para el CTA híbrido. */
export const getHybridCtaTargetIntents = (): Set<string> =>
  new Set(
    env.HYBRID_CTA_TARGET_INTENTS.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

/**
 * Verifica si el CTA híbrido está habilitado para un negocio específico.
 * Si HYBRID_CTA_ENABLED_BUSINESS_IDS está vacío → habilitado para todos.
 */
export const isHybridCtaEnabledForBusiness = (businessId: string): boolean => {
  if (!isHybridCtaEnabled()) return false;
  const ids = env.HYBRID_CTA_ENABLED_BUSINESS_IDS;
  if (!ids || !ids.trim()) return true;
  return ids
    .split(',')
    .map((s) => s.trim())
    .includes(businessId);
};
