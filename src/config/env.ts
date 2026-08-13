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
   * Habilita el ReAct agent dedicado a reservas.
   * Cuando está activo, el agente gestiona la sesión completa de reserva en
   * lenguaje natural (fecha libre, party-size en texto, off-topic temporal).
   * Requiere AGENT_MODE=hybrid para funcionar; en caso contrario se ignora.
   */
  RESERVATION_AGENT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  /**
   * Habilita el ReAct agent dedicado al onboarding (captura de dirección de entrega).
   * Cuando está activo, reemplaza el wizard determinístico por un agente conversacional
   * que maneja texto libre, pausas/delegaciones y reanudaciones.
   * Requiere AGENT_MODE=hybrid para funcionar; en caso contrario se ignora.
   */
  ONBOARDING_AGENT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  /**
   * Habilita el ReAct agent del dueño (métricas por WhatsApp).
   * Requiere AGENT_MODE=hybrid. Sin teléfonos en
   * business_config.owner_whatsapp_phones nadie entra (fail closed).
   */
  OWNER_ASSISTANT_ENABLED: z
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

  /**
   * Worker periódico (`processDraftOrderTimeouts`): reminders, expiración de
   * drafts y cierre de conversaciones por inactividad. Cada tick (~60s) hace
   * varias queries a Postgres. Default `false` para no quemar cómputo en Neon
   * hasta tener una estrategia de costos viable. Opt-in explícito: `true`/`1`.
   * Con `false`, la Alert `PEDIDO_POR_EXPIRAR` tampoco se deriva en el híbrido
   * (sin cierre real el anuncio es ruido).
   */
  ENABLE_DRAFT_ORDER_WORKER: z
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

  /**
   * Cloudflare R2 (object storage S3-compatible). Opcionales al arrancar;
   * se validan al usar el storage provider.
   */
  R2_ACCOUNT_ID: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  /** URL pública del bucket / custom domain, sin slash final. Ej: https://cdn.ejemplo.com */
  R2_PUBLIC_URL: z.string().url().optional(),
  /**
   * Override opcional del endpoint S3.
   * Default: https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
   * Jurisdicción EU: https://<R2_ACCOUNT_ID>.eu.r2.cloudflarestorage.com
   */
  R2_ENDPOINT: z.string().url().optional(),

  // --- PedidosYa Envíos / Courier (experimental / dormido) ---
  // Calibración de tarifas planas vs cotización. Sin acceso API validado aún.
  // Opcionales al arrancar: el feature responde 503 hasta configurarlas.
  /** Base URL Courier API. Default: https://courier-api.pedidosya.com */
  PEDIDOSYA_COURIER_BASE_URL: z.string().url().optional(),
  /** Client ID de la cuenta Envíos del SaaS */
  PEDIDOSYA_CLIENT_ID: z.string().optional(),
  /** Client Secret de la cuenta Envíos del SaaS */
  PEDIDOSYA_CLIENT_SECRET: z.string().optional(),
  /**
   * Override opcional: token ya emitido (salta el login).
   * Útil en pruebas o si PedidosYa entrega un token estático.
   */
  PEDIDOSYA_ACCESS_TOKEN: z.string().optional(),
  /** Path de login. Default: /v3/login */
  PEDIDOSYA_LOGIN_PATH: z.string().optional(),
  /** Path de estimates. Default: /v3/shippings/estimates */
  PEDIDOSYA_ESTIMATES_PATH: z.string().optional(),
  /**
   * Cómo enviar el Authorization header.
   * - raw: `Authorization: <token>` (documentación Courier)
   * - bearer: `Authorization: Bearer <token>`
   */
  PEDIDOSYA_AUTH_HEADER_STYLE: z.enum(['raw', 'bearer']).optional(),
  /** true/1 (default) = estimates en modo test */
  PEDIDOSYA_IS_TEST: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),
  /** Email requerido por algunos entornos PedidosYa en estimates */
  PEDIDOSYA_NOTIFICATION_EMAIL: z.string().email().optional(),
  /** Ciudad fallback para waypoints si el negocio no la tiene */
  PEDIDOSYA_DEFAULT_CITY: z.string().optional(),
  /** Dirección pickup fallback si business.street_address está vacío */
  PEDIDOSYA_DEFAULT_PICKUP_ADDRESS: z.string().optional(),
  /** Teléfono fallback para waypoints */
  PEDIDOSYA_DEFAULT_PHONE: z.string().optional(),
  /** Valor declarado del ítem de calibración (no es el fee de envío) */
  PEDIDOSYA_DEFAULT_ITEM_VALUE: z.coerce.number().positive().optional(),
  /** Colchón de seguridad sobre el promedio PedidosYa. Default 15 */
  PEDIDOSYA_SAFETY_BUFFER_PERCENT: z.coerce.number().min(0).max(100).optional(),
  /** Delay entre cotizaciones para rate limiting. Default 500 */
  PEDIDOSYA_REQUEST_DELAY_MS: z.coerce.number().int().min(0).optional(),

  /**
   * Ventana de tiempo (en horas) dentro de la cual se acepta un comprobante
   * de transferencia asociado a una orden `payment_method='transfer'` y
   * `payment_status='unpaid'`. Default 24.
   */
  TRANSFER_PROOF_WINDOW_HOURS: z.coerce.number().positive().default(24),

  /**
   * Cuántos comprobantes con al menos un check en `fail` puede acumular una
   * orden antes de escalar la conversación a un humano (Fase 8). Los checks
   * en `unknown` no cuentan: un comprobante ilegible o un local que no cargó
   * sus datos bancarios no acercan a nadie al escalamiento.
   *
   * No es un tope de comprobantes correctos: un comprobante que pasa los
   * checks es plata entrando y nunca se rechaza. Default 3.
   */
  TRANSFER_PROOF_MAX_FAILED: z.coerce.number().int().positive().default(3),

  // --- Embajadores (Domingo Sabrosón) ---
  // Feature en sí controlada por business_config.ambassadors_enabled; estas
  // vars son la config global de acceso al servicio (compartida entre negocios).
  /** Base URL del servicio de Embajadores. Sin ella, el feature es un no-op. */
  AMBASSADORS_API_BASE_URL: z.string().url().optional(),
  /** Credencial de integración (Bearer o x-api-key según AMBASSADORS_AUTH_HEADER). */
  AMBASSADORS_API_KEY: z.string().optional(),
  /** Cómo enviar la credencial en register-sale. Default: bearer. */
  AMBASSADORS_AUTH_HEADER: z.enum(['bearer', 'api_key']).default('bearer'),
  /** Timeout de las requests salientes. Default 5000ms. */
  AMBASSADORS_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
});

export type AppEnv = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('[env] Variables inválidas:', z.treeifyError(parsed.error));
  throw new Error('Configuración de entorno inválida');
}

export const env: AppEnv = parsed.data;

export const isHybridAgentMode = (): boolean => env.AGENT_MODE === 'hybrid';

/** Worker de expiración de drafts / idle. Sin él, PEDIDO_POR_EXPIRAR no debe anunciarse. */
export const isDraftOrderWorkerEnabled = (): boolean =>
  env.ENABLE_DRAFT_ORDER_WORKER === true;

export const isCheckoutAgentEnabled = (): boolean =>
  isHybridAgentMode() && env.CHECKOUT_AGENT_ENABLED === true;

export const isReservationAgentEnabled = (): boolean =>
  isHybridAgentMode() && env.RESERVATION_AGENT_ENABLED === true;

export const isOnboardingAgentEnabled = (): boolean =>
  isHybridAgentMode() && env.ONBOARDING_AGENT_ENABLED === true;

export const isOwnerAssistantEnabled = (): boolean =>
  isHybridAgentMode() && env.OWNER_ASSISTANT_ENABLED === true;

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

/**
 * Config global del servicio de Embajadores configurada (URL base presente).
 * No confundir con el flag por negocio `business_config.ambassadors_enabled`:
 * ambas condiciones deben cumplirse para que el feature esté activo.
 */
export const isAmbassadorsConfigured = (): boolean =>
  Boolean(env.AMBASSADORS_API_BASE_URL && env.AMBASSADORS_API_BASE_URL.trim());
