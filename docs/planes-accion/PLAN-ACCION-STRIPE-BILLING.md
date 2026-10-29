# Plan de acción — Suscripciones Stripe (SaaS, obligatorias)

| | |
|--|--|
| **Estado** | Backend Fases 0–5 entregadas en código; Fase 6 (panel) en repo frontend |
| **Fecha** | 2026-09-02 (header actualizado 2026-09-06) |
| **Repo** | `gesty-backend` (API + bot); UI billing = otro repo |
| **Objetivo** | Todo local opera bajo suscripción Stripe (o trial). Sin plan/trial vigente, el bot queda bloqueado. |
| **FEATURES.md** | `BILL-01` … `BILL-05` |

**Contexto del fork:** este plan nació en un repo hermano con clientes de desarrollo personalizado (exentos). En Gesty **no aplica**: el producto es 100 % SaaS self-serve.

**Contexto del fork:** este plan nació en un repo hermano con clientes de desarrollo personalizado (exentos). En Gesty **no aplica**: el producto es 100 % SaaS self-serve.

**Decisiones Fase 0 fijadas:**
- Trial por defecto: **14 días** + tokens del plan `basic` (`DEFAULT_TRIAL_DAYS` / `DEFAULT_TRIAL_PLAN_CODE`).
- STAFF no ve billing (OWNER/ADMIN).
- Grace `past_due`: 0 días.
- Opción B: sin trial/sub activa → bot bloqueado.

---

## 1. Resumen ejecutivo

### Problema hoy

| Área | Estado |
|------|--------|
| Schema `plan` + `subscription` con IDs Stripe | Existe desde `init`; `plan` sin `stripe_price_id` |
| SDK / webhook / Checkout / Portal Stripe | **No implementado** |
| Gate del bot | `evaluateSubscriptionForBotAi` solo trial; no usa `subscription.status` |
| Cuota admin | `GET /api/admin/ai-quota` — 404 si no hay suscripción “activa” |
| Super-admin | Listado básico; sin gestión ni sync Stripe |
| Negocios sin suscripción | **Hoy el bot sigue funcionando** (límites vía `ai_plan` / `ai_blocked`) — en Gesty hay que **dejar de permitir** eso |

### Un solo perfil de negocio (decisión de producto)

| Perfil | Ejemplo | Fila `subscription` | Cobro Stripe |
|--------|---------|----------------------|--------------|
| **SaaS (único)** | Todo local nuevo o existente | Requerida: trial o plan activo | Sí (salvo trial manual sin Stripe en onboarding) |

No existe perfil “custom / exento”. Si aparece `billing_mode` en schema (legado del fork), se trata siempre como `subscription` o se elimina/simplifica en Fase 1.

### Solución por fases

| Fase | Entrega | Stripe real |
|------|---------|-------------|
| **0** | Decisiones + política de bloqueo | No |
| **1** | Schema planes + evaluador unificado (suscripción obligatoria) | No |
| **2** | APIs lectura (plans, subscription, quota) | No |
| **3** | Webhook + sync BD ↔ `business` | Test keys + CLI |
| **4** | Checkout + Portal | Test keys |
| **5** | Super-admin gestión (trial, sync, cancel, overrides de cupo) | Test keys |
| **6** | Frontend billing + hardening prod | Live opcional |

### Fuera de alcance inicial

- Stripe como pasarela de **pedidos** del restaurante (eso es Mercado Pago — otro dominio)
- Facturación fiscal / AFIP
- Múltiples suscripciones por negocio
- Planes anuales (se puede agregar en Fase 4+ con segundo `stripe_price_id`)
- Emails transaccionales propios (Stripe / Portal cubren MVP)
- Negocios exentos / `billing_mode = custom` (no forma parte de Gesty)

---

## 2. Arquitectura actual (referencia)

```
business
  billing_mode          default "subscription" — legado; en Gesty siempre subscription
  ai_plan, ai_monthly_token_limit, ai_blocked, ai_reset_at
  subscription?         1:1 opcional en schema — en runtime se exige trial o activa

Bot (mainGraph)
  subscriptionAccessGateNode → evaluateSubscriptionForBotAi (solo trial)

Admin
  GET /api/admin/ai-quota → getBusinessAiQuota (null si sin sub activa)

Super-admin
  GET /api/super-admin/businesses → resumen subscription o fallback ai_reset_at

Pagos pedidos (distinto)
  POST /api/payments/mercado-pago/webhook → payment_intent / orders
```

**Archivos clave hoy:**

| Archivo | Rol |
|---------|-----|
| `prisma/schema.prisma` | `plan`, `subscription`, `business.billing_mode` |
| `src/services/subscriptionBotAccess.service.ts` | Gate trial |
| `src/services/subscription/businessAiQuota.service.ts` | `isActiveSubscription`, cuota |
| `src/services/superAdminBusinesses.service.ts` | Listado + `mapStripeStatusToUi` |
| `src/controllers/adminAiQuota.controller.ts` | Cuota admin |
| `src/controllers/payments/mercadoPagoWebhook.controller.ts` | Patrón webhook (otro dominio) |
| `src/index.ts` | Registro rutas; `express.json` global |

---

## 3. Decisiones de diseño — NO volver a discutirlas en MVP

**D1 — Suscripción obligatoria para todos los locales.**

Todo `business` debe tener trial vigente o `subscription` con estado activo (`active` / `trialing` según `isActiveSubscription`). Sin eso: bot bloqueado y panel con CTA de suscripción.

Si el schema conserva `billing_mode`, el único valor operativo es `subscription`. No se implementa ni se documenta `custom` en Gesty. Super-admin **no** convierte a exento.

**D2 — Sin fila `subscription` activa ⇒ bloqueo (Opción B).**

Política MVP fija:

- **Bloquear** bot si no hay trial vigente ni sub activa.
- Panel muestra “Sin plan activo — suscribite” + Checkout.
- Onboarding: al crear el local, super-admin (o flujo de alta) otorga trial vía `grant-trial` **antes** de que el bot atienda tráfico real.

Trial: fila `subscription` con `is_trial = true` + `trial_end` (manual o Stripe `trialing`).

**D3 — Un solo evaluador de acceso: `evaluateBusinessBillingAccess`.**

Reemplaza el uso disperso de `evaluateSubscriptionForBotAi` + lógica suelta.

Orden de evaluación:

1. Si `ai_blocked` → bloquear (mensaje de cupo / bloqueo admin; puede vivir en `openai.service` como hoy).
2. Si no hay `subscription` → bloquear (“Suscribite desde el panel”).
3. Si trial vencido (fecha o tokens de trial) → bloquear.
4. Si hay `subscription` y `!isActiveSubscription(sub)` → bloquear (mensaje según `status`: `past_due`, `canceled`, etc.).
5. Else → `ok`.

**D4 — Webhook Stripe es a nivel plataforma (no por negocio).**

Ruta: `POST /api/billing/stripe/webhook`.  
Body **raw** para firma (registrar antes de `express.json()` o `express.raw` en esa ruta).

**D5 — Sync webhook → `subscription` + `business`.**

Al `customer.subscription.updated` / `invoice.paid`:

- Upsert `subscription`
- Actualizar `business.ai_plan`, `ai_monthly_token_limit`, `ai_blocked` según plan

**D6 — Catálogo de planes en BD, prices en Stripe.**

Tabla `plan` con `stripe_price_id` (test/live por entorno o por columna). Checkout usa price de BD, no inventa IDs en código.

**D7 — Super-admin gestiona trial, sync, cancel y overrides de cupo — no exenciones.**

Acciones MVP:

- Otorgar / extender trial
- Sync desde Stripe
- Cancel at period end
- Override `ai_plan` / `ai_monthly_token_limit` / `ai_blocked` (soporte)

**No** hay endpoint ni UI para “marcar como custom / sin cobro”.

**D8 — `GET /api/admin/ai-quota` evoluciona de forma coherente con el bloqueo.**

- Sin sub activa / sin trial: responde 200 con `subscription: null` (o estado `requires_subscription: true`) + cuota si hay datos en `business`, **o** 402/403 documentado — alinear con `GET billing/subscription`. Preferencia MVP: **200** con flags claros para que el frontend muestre paywall sin tratarlo como error de red.
- Con sub activa: cuota + bloque subscription.

**D9 — Separación explícita billing SaaS vs pagos de pedidos.**

No reutilizar `business_payment_provider` para Stripe SaaS. Keys en env de plataforma.

**D10 — Alta de local incluye trial por defecto.**

Todo negocio nuevo nace con trial (script de creación / super-admin), para no dejar locales “huérfanos” bloqueados el día 0. Duración y cupo de trial: definir en Fase 0 (sugerencia: 14 días + límite de tokens del plan basic).

---

## 4. Cómo usar este plan

1. Fases **en orden**. Cada una deja el sistema consistente y testeable.
2. Cada tarea: **archivos**, **cambio concreto**, **criterio de aceptación**, **cómo verificar**.
3. Después de cada fase: `npx tsc --noEmit` y `npm test`.
4. Marcá `[ ]` → `[x]` al completar; agregá **Estado (fecha)** si difiere.
5. PRs sugeridos al final (§7).

**Baseline antes de Fase 1:**

- [ ] `npx tsc --noEmit` → 0 errores.
- [ ] `npm test` → anotar passed/failed actuales.
- [ ] Listar negocios existentes: ¿tienen `subscription` / trial? Plan de grant-trial masivo si hace falta antes de activar el gate estricto.

---

## Fase 0 — Preparación y contrato

### Tarea 0.1 — Inventario de negocios en BD

**Entregable:** lista en comentario de PR o tabla en este doc.

| Negocio | ¿Fila `subscription`? | Estado / trial | Acción pre-gate |
|---------|------------------------|----------------|------------------|
| … | sí/no | active / trial / — | grant-trial / checkout |

**Criterio:** ningún local queda sin trial o sub antes de desplegar Fase 1 en un entorno con tráfico real.

---

### Tarea 0.2 — Confirmar decisiones D1–D10

**Preguntas si hay duda:**

- ¿STAFF ve billing? (MVP: no — solo OWNER/ADMIN)
- ¿Duración y cupo del trial por defecto? (sugerencia: 14 días + tokens basic)
- ¿Grace period en `past_due`? (MVP: 0 días — bloquear bot; super-admin puede desbloquear temporalmente con `ai_blocked = false` + trial corto)

**Criterio:** tick explícito en PR. Suscripción obligatoria y Opción B quedan firmes.

---

### Tarea 0.3 — Variables de entorno (documentación)

Agregar a `.env.example` cuando empiece Fase 3:

```env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
# Opcional frontend
STRIPE_PUBLISHABLE_KEY=pk_test_...
```

**Criterio:** documentado; app arranca sin keys (billing deshabilitado con log claro — Checkout/Portal no disponibles; el gate sigue aplicando reglas de BD).

---

## Fase 1 — Modelo de datos + evaluador unificado (sin Stripe)

**Objetivo:** contrato de suscripción obligatoria en código; bot y APIs coherentes. **Cero llamadas a Stripe.**

### Tarea 1.1 — Schema `plan` + SQL

**Archivos:**

- `prisma/schema.prisma`
- `prisma/sql/add_plan_stripe_fields.sql`

**Cambio:**

```sql
ALTER TABLE plan ADD COLUMN IF NOT EXISTS stripe_product_id TEXT;
ALTER TABLE plan ADD COLUMN IF NOT EXISTS stripe_price_id TEXT UNIQUE;
ALTER TABLE plan ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE plan ADD COLUMN IF NOT EXISTS features JSONB DEFAULT '{}';
```

Opcional: documentar o fijar `billing_mode` siempre `subscription`; no agregar flujo `custom`. Si se limpia legado: migración que setee todos a `subscription` y/o deje de leer `custom` en código.

**Criterio:** SQL aplicado en BD compartida; `prisma generate` OK.

---

### Tarea 1.2 — Seed de planes

**Archivo:** `scripts/billing/seed-plans.ts`

**Cambio:** upsert `basic`, `pro`, `business` con `token_limit` alineado a `aiLimits.ts`. `stripe_price_id` vacío hasta Fase 3.

**Verificar:** `npx ts-node -r dotenv/config scripts/billing/seed-plans.ts`

---

### Tarea 1.3 — Tipos y constantes de billing

**Archivos:**

- `src/types/billing.dto.ts` (nuevo)
- `src/constants/billing.ts` (nuevo) — estados activos, flags de acceso, mensajes de bloqueo

**Criterio:** typecheck sin `string` suelto en servicios críticos. Sin type guards de `custom`.

---

### Tarea 1.4 — `evaluateBusinessBillingAccess`

**Archivo:** `src/services/billing/evaluateBusinessBillingAccess.service.ts` (nuevo)

**Lógica:** D2 + D3; reutilizar `isActiveSubscription` de `businessAiQuota.service.ts`.

**Mensajes al bot (sugeridos):**

| Caso | Mensaje |
|------|---------|
| Sin subscription | “Este local no tiene un plan activo. Suscribite desde el panel de administración.” |
| Trial fecha | (existente) período de prueba finalizado |
| Trial tokens | (existente) tokens agotados |
| `past_due` / canceled / inactive | “Tu suscripción no está activa. Actualizá el pago desde el panel.” |

**Tests:** `src/services/billing/__tests__/evaluateBusinessBillingAccess.test.ts`

Casos obligatorios:

- [ ] Sin fila `subscription` → `ok: false`
- [ ] Trial vencido → `ok: false`
- [ ] `status = canceled` → `ok: false`
- [ ] `status = past_due` → `ok: false`
- [ ] Trial vigente → `ok: true`
- [ ] `status = active` → `ok: true`

---

### Tarea 1.5 — Migrar consumidores al evaluador

**Archivos a modificar:**

- `src/services/subscriptionBotAccess.service.ts` — delegar a `evaluateBusinessBillingAccess` o deprecar
- `src/graph/nodes/gates/index.ts`
- `src/services/ai/openai.service.ts`
- `src/services/ai/speechToText.service.ts`
- `src/services/ai/paymentProofVision.service.ts`
- `src/controllers/adminPromotions.controller.ts`

**Criterio:** tests existentes de IA pasan; nuevos tests de gate cubren bloqueo sin sub.

---

### Tarea 1.6 — Preparar locales existentes (trials)

**Entregable:** script one-off o uso de super-admin `grant-trial` (Fase 5) / SQL controlado:

- Para cada negocio sin sub activa: crear trial con `trial_end` y cupo acordados en Fase 0.
- Asegurar que **ningún** local de prod/staging queda sin cobertura el día del deploy del gate.

**Criterio:** query de auditoría: 0 negocios sin trial vigente ni sub activa (o lista explícita de locales aún no onboardeados y sin bot conectado).

---

### Criterio de aceptación Fase 1

- [ ] Local sin `subscription` → bot bloqueado con mensaje de suscripción.
- [ ] Local con sub cancelada → bot bloqueado.
- [ ] Local con trial / active → bot OK (sujeto a cupo/`ai_blocked`).
- [ ] `npm test` verde en módulos billing + IA.

---

## Fase 2 — APIs de lectura (admin + super-admin, sin Stripe)

**Objetivo:** el frontend puede mostrar planes, estado y paywall sin Checkout.

### Tarea 2.1 — `planCatalog.service`

**Archivo:** `src/services/billing/planCatalog.service.ts`

- `listActivePlans()` — desde BD, orden por precio o `code`
- DTO público: `code`, `name`, `monthly_price_usd`, `token_limit`, `description`, `features`, `has_stripe_price`

---

### Tarea 2.2 — `GET /api/admin/billing/plans`

**Archivos:**

- `src/controllers/adminBilling.controller.ts`
- `src/routes/adminOrders.routes.ts` — `GET /billing/plans`, roles OWNER/ADMIN

**Respuesta ejemplo:**

```json
{
  "requires_subscription": true,
  "plans": [
    { "code": "basic", "name": "Basic", "token_limit": 100000, "monthly_price_usd": "29.00", "can_subscribe": false }
  ]
}
```

`can_subscribe: false` si `stripe_price_id` null (pre-Fase 4).

---

### Tarea 2.3 — `GET /api/admin/billing/subscription`

Estado completo del tenant:

```json
{
  "requires_subscription": true,
  "access_ok": false,
  "subscription": null,
  "quota": { "tokens_used": 0, "tokens_limit": 100000, "...": "..." },
  "cta": "checkout"
}
```

Con trial/activa: `access_ok: true`, detalle de plan, `cta: "portal"` si ya hay `stripe_customer_id`.

---

### Tarea 2.4 — Evolucionar `GET /api/admin/ai-quota`

**Archivo:** `src/controllers/adminAiQuota.controller.ts` + `businessAiQuota.service.ts`

- Sin sub activa → 200 con `subscription: null` + `requires_subscription: true` + cuota desde `business` si existe (alineado a 2.3)
- Con sub activa → cuota + bloque subscription

**Criterio:** frontend puede renderizar paywall sin depender de 404.

---

### Tarea 2.5 — Extender super-admin listado

**Archivos:**

- `src/types/superAdminBusiness.dto.ts`
- `src/services/superAdminBusinesses.service.ts`

Agregar a cada ítem: `has_subscription_row`, `subscription_status` (o UI mapeada), `access_ok` / `is_trial`, `trial_end`.

**Criterio:** listado distingue trial / active / past_due / sin sub.

---

### Criterio de aceptación Fase 2

- [ ] `GET billing/subscription` sin sub: `requires_subscription: true`, `access_ok: false`
- [ ] `GET billing/plans` devuelve catálogo seed
- [ ] Contratos documentados en este plan o README API

---

## Fase 3 — Webhook Stripe + sync (test mode)

**Objetivo:** BD refleja Stripe para todos los locales.

### Tarea 3.1 — Dependencia y cliente

- `package.json` → `stripe`
- `src/services/billing/stripe.client.ts` — lazy init; falla controlada si no hay key

---

### Tarea 3.2 — Mapper y sync

**Archivos:**

- `src/services/billing/stripeSubscriptionSync.service.ts`
- `src/services/billing/mapStripeSubscription.ts`

Funciones:

- `upsertSubscriptionFromStripe(stripeSub, businessId)`
- `syncBusinessAiFromPlan(businessId, planId | planCode)`
- Resolver `businessId` vía metadata / `stripe_customer_id` / `client_reference_id` del Checkout

---

### Tarea 3.3 — Tabla idempotencia webhook (opcional pero recomendada)

**SQL:** `prisma/sql/add_stripe_webhook_events.sql`

`stripe_event_id` UNIQUE, `type`, `processed_at`, `payload` JSONB.

---

### Tarea 3.4 — Webhook handler

**Archivos:**

- `src/controllers/billingStripeWebhook.controller.ts`
- `src/index.ts` — **raw body** en `/api/billing/stripe/webhook`

Eventos MVP:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`

**Tests:** fixtures Stripe + mock prisma.

---

### Tarea 3.5 — Poblar `stripe_price_id` en planes

Script `scripts/billing/sync-stripe-plans.ts` o manual en Dashboard test.

**Criterio:** `plan.stripe_price_id` non-null para al menos un plan en test.

---

### Tarea 3.6 — Verificación manual

```bash
stripe listen --forward-to localhost:5001/api/billing/stripe/webhook
# Disparar test event o completar checkout en Fase 4
```

**Criterio:** fila `subscription` creada/actualizada; `business.ai_plan` actualizado.

---

### Criterio de aceptación Fase 3

- [ ] Webhook rechaza firma inválida
- [ ] Evento duplicado no duplica filas
- [ ] Sync actualiza `subscription` + límites AI del business

---

## Fase 4 — Checkout + Customer Portal

**Objetivo:** el dueño del local se suscribe y gestiona sin super-admin.

### Tarea 4.1 — `stripeCustomer.service`

Crear/obtener Customer Stripe por `business_id`; guardar `stripe_customer_id` en `subscription` (o columna en `business` si se prefiere — MVP: solo en `subscription` tras primer checkout).

---

### Tarea 4.2 — `POST /api/admin/billing/checkout`

Body: `{ "plan_code": "pro" }`

- Disponible para todo local OWNER/ADMIN
- Devuelve `{ "url": "https://checkout.stripe.com/..." }`
- `success_url` / `cancel_url` → panel admin (`CORS_ORIGIN`)
- Metadata: `business_id` (+ `plan_code`) para el webhook

---

### Tarea 4.3 — `POST /api/admin/billing/portal`

- Requiere `stripe_customer_id`
- Devuelve URL Portal
- Sin customer → 400 claro (“Suscribite primero”)

---

### Tarea 4.4 — Actualizar `can_subscribe` en listado planes

`can_subscribe = stripe_price_id != null` (y Stripe configurado)

---

### Criterio de aceptación Fase 4

- [ ] Local completa Checkout test → webhook → sub activa → bot OK
- [ ] Local sin sub → bot bloqueado; Checkout disponible
- [ ] Portal abre y permite cancelar (test)

---

## Fase 5 — Super-admin gestión

**Objetivo:** operación y soporte sin Dashboard Stripe para casos comunes. **Sin exenciones.**

### Tarea 5.1 — `GET /api/super-admin/businesses/:id/billing`

Detalle: subscription completa, stripe IDs, quota, últimos eventos webhook, `access_ok`.

---

### Tarea 5.2 — `PATCH /api/super-admin/businesses/:id/billing`

Body parcial (overrides de cupo / bloqueo — no “modo custom”):

```json
{
  "ai_plan": "business",
  "ai_monthly_token_limit": 500000,
  "ai_blocked": false
}
```

---

### Tarea 5.3 — `POST .../billing/grant-trial`

Crea/actualiza `subscription` con `is_trial`, `trial_end`, cupo, sin Stripe (o sync con Stripe trial en v2).

Usado en onboarding y soporte (“extender prueba”).

---

### Tarea 5.4 — `POST .../billing/sync-stripe`

Re-fetch subscription desde Stripe API por `stripe_subscription_id`.

---

### Tarea 5.5 — `POST .../billing/cancel`

Cancel at period end vía Stripe API + sync.

---

### Criterio de aceptación Fase 5

- [ ] Super-admin otorga trial a local nuevo → bot OK hasta `trial_end`
- [ ] Override de tokens sin tocar Stripe funciona
- [ ] Sync reconcilia estado tras cambio manual en Dashboard
- [ ] No existe API para marcar negocio como exento de pago

---

## Fase 6 — Frontend + producción

**Repo:** panel admin (fuera de este plan detallado).

### Tarea 6.1 — Pantalla Billing

- Barra de tokens (`ai-quota` / `billing/subscription`)
- Cards de planes + CTAs Checkout / Portal
- Paywall claro si `access_ok: false` / `requires_subscription: true`
- Badge de trial con fecha de fin

---

### Tarea 6.2 — Super-admin UI

- Columnas: status sub / trial / sin sub / past_due
- Filtros: sin sub, trial por vencer, past_due, active
- Acciones: sync, grant-trial, override cupo, cancel
- **Sin** acción “set custom / exento”

---

### Tarea 6.3 — Producción

- Keys live, webhook endpoint HTTPS público
- Runbook: migrar price IDs test → live
- Monitoreo: alertas webhook fallidos
- Checklist: todos los locales de prod tienen trial o sub antes del cutover del gate estricto

---

### Criterio de aceptación Fase 6

- [ ] Flujo completo: alta → trial → Checkout → Portal → cancelación reflejada en bot
- [ ] Local sin pagar / sin trial no opera el bot en prod

---

## 5. Matriz de comportamiento (referencia rápida)

| Estado | Bot | Panel billing | Stripe |
|--------|-----|---------------|--------|
| Sin `subscription` | **Bloqueado** | Paywall + Checkout | Checkout |
| Trial vigente | OK | Trial + cuota | Opcional |
| Trial vencido | **Bloqueado** | Checkout | Checkout |
| `active` / `trialing` Stripe | OK | Plan + Portal | Sí |
| `past_due` / `canceled` | **Bloqueado** | Portal + aviso | Sí |

---

## 6. Riesgos y mitigaciones

| Riesgo | Mitigación |
|--------|------------|
| Bloquear locales existentes al activar gate | Tarea 0.1 + 1.6: grant-trial masivo antes del deploy |
| Local nuevo sin trial el día 0 | D10: trial por defecto en alta |
| `express.json` rompe firma webhook | Raw route en `index.ts` (D4) |
| Schema drift con backend hermano (fork) | SQL en `prisma/sql/`; no reintroducir flujos `custom` de docs viejos |
| Confundir Stripe SaaS con MP pedidos | D9; rutas distintas |
| Grace `past_due` demasiado agresivo | MVP 0 días; soporte vía trial corto / override |

---

## 7. PRs sugeridos

| PR | Fases | Título |
|----|-------|--------|
| 1 | 1 | `feat(billing): evaluateBusinessBillingAccess (subscription required)` |
| 2 | 2 | `feat(billing): admin read APIs plans/subscription/quota` |
| 3 | 3 | `feat(billing): stripe webhook + subscription sync` |
| 4 | 4 | `feat(billing): checkout + customer portal` |
| 5 | 5 | `feat(billing): super-admin trial/sync/cancel` |
| 6 | 6 | Frontend (repo admin) |

---

## 8. Checklist de cutover (ejecutar antes/después de activar gate estricto)

- [ ] Inventario: todos los locales con trial o sub activa
- [ ] Local de prueba sin sub → bot responde mensaje de suscripción (no atiende pedidos)
- [ ] Local con trial → bot OK
- [ ] `GET /api/admin/ai-quota` → 200 con flags de paywall si aplica
- [ ] `GET /api/admin/billing/subscription` → `requires_subscription: true` coherente
- [ ] `POST /api/admin/billing/checkout` → URL Stripe (test)
- [ ] Tras Checkout test → webhook → bot OK

---

## 9. Estado de implementación

| Fase | Estado | Fecha |
|------|--------|-------|
| 0 | Hecho (baseline + env Stripe + decisiones trial 14d) | 2026-09-02 |
| 1 | Hecho (schema plan/stripe, evaluador, gate, tests) | 2026-09-02 |
| 2 | Hecho (APIs plans/subscription/quota + super-admin flags) | 2026-09-02 |
| 3 | Hecho (SDK stripe, webhook raw, sync, idempotencia) | 2026-09-02 |
| 4 | Hecho (Checkout + Portal admin) | 2026-09-02 |
| 5 | Hecho (super-admin billing: trial/sync/cancel/patch) | 2026-09-02 |
| 6 | Pendiente (frontend panel + cutover prod) | |

### Notas operativas post-implementación

1. Aplicar SQL en Postgres:
   - `prisma/sql/add_plan_stripe_fields.sql`
   - `prisma/sql/add_stripe_webhook_events.sql`
2. Seed planes: `npx ts-node -r dotenv/config scripts/billing/seed-plans.ts`
3. Con Stripe test: `npx ts-node -r dotenv/config scripts/billing/sync-stripe-plans.ts`
4. Antes del cutover del gate en un entorno con tráfico: `npx ts-node -r dotenv/config scripts/billing/grant-trial.ts --all-missing`
5. Webhook local: `stripe listen --forward-to localhost:5001/api/billing/stripe/webhook`
