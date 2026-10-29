# Evidencia — `npm run test:reservation-production`

Fecha: 22/09/2026 · Comando: `E2E_RUN=1 vitest run -c vitest.e2e.reservation-production.config.ts`

## Resultado

**FAIL en `beforeAll`.** La suite diagnóstica de reservas nunca llegó a correr conversaciones:
7 de 8 tests quedaron `skipped` y no se generó `e2e/.last-reservation-production-report.json`.

```
 ❯ e2e/reservation-production.e2e.test.ts (8 tests | 7 skipped) 17518ms

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  e2e/reservation-production.e2e.test.ts > reservation production conversations (diagnóstica)
PrismaClientKnownRequestError:
Invalid `prisma.$queryRaw()` invocation:
Raw query failed. Code: `42703`. Message: `column "storefront_enabled" does not exist`
 ❯ fetchBusinessConfigRow src/services/businessConfig.service.ts:253:16
 ❯ getBusinessConfig      src/services/businessConfig.service.ts:293:15
 ❯ upsertBusinessConfig   src/services/businessConfig.service.ts:307:19
 ❯ pinE2eBusinessConfig   e2e/helpers/graphHarness.ts:104:3
 ❯ resetE2eCustomer       e2e/helpers/graphHarness.ts:222:3

 Test Files  1 failed (1)
      Tests  1 passed | 7 skipped (8)
   Duration  19.41s
```

El fallo es **de entorno, no de la lógica de reservas**: ningún turno conversacional se ejecutó,
así que esta corrida no dice nada sobre el comportamiento del agente de reservas.

## Causa raíz

La suite corre contra una base de datos **distinta** a la de desarrollo, y esa base no tiene
aplicada la migración de `storefront_enabled`.

### 1. El `beforeAll` toca `business_config` antes de cualquier turno

`resetE2eCustomer()` fija personalidad neutral y `humanize_messages: false` para que los E2E sean
reproducibles; eso pasa por `getBusinessConfig`, que lee columnas explícitas con `$queryRaw`:

```253:289:src/services/businessConfig.service.ts
  const rows = await prisma.$queryRaw<
    Array<BusinessConfig>
  >`
    SELECT
      bot_enabled,
      storefront_enabled,
      ...
    FROM business_config
    WHERE business_id = ${businessId}::uuid
    LIMIT 1
  `;
```

Al ser `SELECT` de columnas nombradas, si una falta en la base el error es fatal para todo el `beforeAll`.

### 2. El test carga `.env`, no `.env.development`

El helper de entorno de E2E importa `dotenv/config`, que lee `.env` de forma incondicional:

```1:8:e2e/helpers/env.ts
import 'dotenv/config';

/** Variables mínimas para correr e2e contra BD + LLM reales. Requiere opt-in `E2E_RUN=1`. */
export const isE2eEnabled = (): boolean =>
```

Como `dotenv` no pisa variables ya definidas, el `loadEnv()` de la app (que prioriza
`.env.development`) llega tarde: en la corrida se ve `injected env (0) from .env.development`,
es decir cero variables inyectadas.

```19:30:src/config/loadEnv.ts
export function loadEnv(): string {
  if (loadedPath) return loadedPath;

  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const byNodeEnv =
    nodeEnv === 'production' ? '.env.production' : '.env.development';
```

Además `.env` define `DATABASE_URL` **dos veces** (la última gana), por lo que la URL efectiva es
el endpoint Neon `ep-mute-smoke`, mientras que `.env.development` apunta a `ep-red-credit`.

### 3. Verificación directa contra ambas bases

Consultando `information_schema.columns` para `business_config`:

| Base (endpoint Neon) | Origen | Columnas | `storefront_enabled` |
|---|---|---|---|
| `ep-red-credit` | `.env.development` | 32 | presente |
| `ep-mute-smoke` | `.env` (la que usa el test) | 31 | **ausente** |

La migración existe en el repo pero es manual y nunca se aplicó en `ep-mute-smoke`:

```1:8:prisma/sql/add_storefront_enabled.sql
-- Canal storefront (PLAN-ACCION-STOREFRONT-CANAL.md, BE-15).
-- Un flag prende vitrina + pedidos web.
-- Default true (incluido en todos los planes; admin kill switch). Ver también
-- storefront_enabled_default_true.sql si esta columna ya existía con DEFAULT false.
-- Ejecutar manualmente en Postgres (este repo no migra al arrancar).

ALTER TABLE business_config
  ADD COLUMN IF NOT EXISTS storefront_enabled BOOLEAN NOT NULL DEFAULT true;
```

## Nota sobre la sandbox

Las dos primeras corridas fallaron antes, con `getaddrinfo EAI_AGAIN` sobre el host de Neon:
es la resolución DNS bloqueada por la sandbox del agente, no un problema del proyecto.
Fuera de la sandbox el host resuelve y la conexión funciona; el resultado válido es el de arriba.

## Opciones de resolución (no aplicadas)

1. **Aplicar la migración en `ep-mute-smoke`** — correr `prisma/sql/add_storefront_enabled.sql`
   (es idempotente, usa `ADD COLUMN IF NOT EXISTS`) en esa base.
2. **Que los E2E usen la base de desarrollo** — evitar el `import 'dotenv/config'` de
   `e2e/helpers/env.ts` en favor de `loadEnv()`, o correr con
   `DOTENV_CONFIG_PATH=.env.development`.
3. **Limpiar `.env`** — tiene dos `DATABASE_URL`, lo que hace ambiguo a qué base apunta cada proceso.

Hasta que se decida una, la suite no puede reportar nada sobre reservas.
