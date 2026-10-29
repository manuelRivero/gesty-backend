# Plan de acción — Canal storefront (`storefront_enabled`)

| | |
|--|--|
| **Estado** | **disponible** (BE-15), con el **entitlement comercial de Shopping reabierto** desde 2026-10-13 (ver §0). BILL-06 ya **no** está cancelado: existe plan Stripe `shopping_only`. |
| **Fecha** | 2026-09-20 (original) · actualizado 2026-10-13 |
| **Repo** | `gesty-backend` (flag + gates); UI admin = **repo hermano** |
| **Objetivo** | Kill switch **operativo** del canal web (menú + pedidos mostrador), independiente del bot WhatsApp/IA, **más** el entitlement **comercial** de Shopping (`plan.shopping_enabled`) que decide si el negocio puede acceder a Shopping. |
| **FEATURES.md** | `BE-15` (disponible); `BILL-06` (reabierto — ver PLAN-ACCION-SHOPPING-ONLY.md) |
| **Depende de** | [ORD-10 storefront público](./PLAN-ACCION-STOREFRONT-PUBLICO.md), [BE-03 `bot_enabled`](./PLAN-ACCION-CAPABILITIES-BOOTSTRAP.md) (D11), [PLAN-ACCION-SHOPPING-ONLY.md](./PLAN-ACCION-SHOPPING-ONLY.md) |
| **Handoff admin** | [CONTEXTO-ADMIN-STOREFRONT-CANAL.md](./CONTEXTO-ADMIN-STOREFRONT-CANAL.md) |

---

## 0. Actualización 2026-10-13 — Shopping Only reabre BILL-06

**Decisión comercial nueva:** Shopping ahora requiere una suscripción con un
plan que tenga `shopping_enabled=true`. Esto **revierte D7/D10 y §5** de este
documento (abajo, sin borrar — se deja la discusión original como historial).
Detalle completo, modelo de datos, puntos de entrada protegidos y matriz de
estados: [PLAN-ACCION-SHOPPING-ONLY.md](./PLAN-ACCION-SHOPPING-ONLY.md).

Resumen de lo que cambia respecto al resto de este documento:

- **Ya no es cierto** que "el plan Stripe no restringe el canal web" (§2) ni
  que "billing gatea solo el bot/IA" (§1, §4). Ahora hay DOS entitlements
  comerciales independientes: `plan.ai_enabled` (IA) y `plan.shopping_enabled`
  (Shopping). Ambos conviven con los controles operativos existentes
  (`storefront_enabled`, `orders_enabled`, `bot_enabled`), que **no cambian**
  y siguen siendo necesarios además del entitlement — no sustitutos uno del
  otro.
- `resolveActivePublicBusiness`/`listPublicStorefronts`
  (`src/services/publicStorefront.service.ts`) ahora exigen, además de
  `is_active` + `storefront_enabled`, que la suscripción del negocio otorgue
  `shopping_enabled` (trial vigente, o plan con `shopping_enabled=true` y
  suscripción no vencida). Sin esa suscripción, la API pública devuelve el
  mismo 404 "local no disponible" que usaba para storefront apagado — no se
  distingue el motivo en la respuesta pública.
- Existe el plan Stripe `shopping_only` (`ai_enabled=false`,
  `shopping_enabled=true`) en `src/constants/planCatalog.ts`, pendiente de
  precio comercial real antes de publicarse como vendible.

## 1. Resumen ejecutivo

El storefront (`/shopping/[slug]`) es un canal **aislado** de WhatsApp y Mercado Pago (ORD-10).

- Publicación: `business.is_active` ∧ `storefront_enabled` ∧ slug ∧ **entitlement `shopping_enabled` vigente (§0, nuevo desde 2026-10-13)**.
- POST orders: además `orders_enabled` + fulfillment + horario.
- `bot_enabled` solo apaga el bot; **no oculta la web** (esto no cambió).
- Billing gatea el bot/IA (`evaluateBusinessBillingAccess`/`businessCapabilities.service.ts`) **y, desde §0, también Shopping** vía el mismo `businessCapabilities.service.ts`. Ya no es cierto que "no hay entitlement de canal web" — sí hay uno, separado del de IA.

### Decisiones — **FIJADAS** (actualizado)

| # | Decisión | Resolución |
|---|----------|------------|
| D1 | ¿Uno o dos flags de canal web? | **Un solo flag** `storefront_enabled`: prende vitrina **y** pedidos web juntos. |
| D2 | ¿Dónde vive el flag? | `business_config.storefront_enabled` (mismo nivel que `bot_enabled`). |
| D3 | Relación con `orders_enabled` | Se **mantiene**. Con storefront on, el POST sigue exigiendo caps operativas. |
| D4 | Relación con `bot_enabled` | **Independiente**. Matriz: solo bot / solo web / full. |
| D5 | Default en creates nuevos | `storefront_enabled = true` (incluido en plan; opt-out vía admin). |
| D6 | Migración legacy | Locales con `slug` → `true`. SQL: `add_storefront_enabled.sql` + `storefront_enabled_default_true.sql` para ALTER DEFAULT. |
| D7 | Monetización | ~~Sin SKU aparte~~ **Revertido 2026-10-13 (§0):** existe el plan Stripe `shopping_only`. Ver PLAN-ACCION-SHOPPING-ONLY.md. |
| D8 | Orden de entrega | Solo flag + gates (BE-15). **No** hay Fase B de entitlements/channels. (Sin cambios: esto es sobre la lógica de delivery, no sobre el entitlement de acceso.) |
| D9 | Sin `web_orders_enabled` | No. Un flag cubre vitrina + pedidos. (Sin cambios.) |
| D10 | `business.features` / `plan.features.channels` | Sigue sin ser fuente de verdad — pero desde §0 sí existe fuente de verdad: las columnas tipadas `plan.ai_enabled`/`plan.shopping_enabled` (no un JSON). |

---

## 2. Modelo (dos capas)

```text
Config canal (qué prendió)     Capacidad operativa
──────────────────────────     ───────────────────
bot_enabled                →   (grafo WA + caps + billing)
storefront_enabled         →   orders_enabled + takeaway/delivery + menú
```

Sin `storefront_enabled`, la API pública no publica el local (404 `"local no disponible"`).  
El plan Stripe **no** restringe el canal web.

### Matriz producto

| Producto | Config |
|----------|--------|
| Solo bot | `bot_enabled=true`, `storefront_enabled=false` |
| Solo web | `bot_enabled=false`, `storefront_enabled=true` |
| Full | ambos `true` (default de creates) |

---

## 3. Fases

### Fase A — Flag + gates (BE-15) — **hecho**

| # | Trabajo | Estado |
|---|---------|--------|
| A1 | Columna + SQL | hecho |
| A2 | `DEFAULT_CONFIG`, tipos, upsert / admin PATCH | hecho (`default true`) |
| A3–A4 | Gate GET/POST públicos | hecho |
| A5–A7 | Admin API + tests + docs ORD-10 | hecho |

### Fase B — Plan “solo web” (BILL-06) — **reabierto 2026-10-13 (§0)**

~~No se implementa SKU Stripe ni `plan.features.channels` ni gate fail-closed por entitlement. La vitrina no es producto de cobro aparte.~~
Superado: ver [PLAN-ACCION-SHOPPING-ONLY.md](./PLAN-ACCION-SHOPPING-ONLY.md). El gate fail-closed existe (`resolveBusinessCapabilities`), pero no usa `plan.features` (JSON) — usa columnas tipadas `plan.ai_enabled`/`plan.shopping_enabled`, consistente con D10.

---

## 4. Gates runtime (contrato)

| Superficie | Condición para OK |
|------------|-------------------|
| GET storefront (`/api/public/businesses/:slug…`) | `is_active` ∧ `storefront_enabled` ∧ **entitlement `shopping` vigente (§0)** |
| POST/GET orders públicos | Lo anterior ∧ `orders_enabled` ∧ fulfillment ∧ horario/`orders_when_closed` |
| Canal WhatsApp / IA | `bot_enabled` ∧ billing vigente ∧ capabilities ∧ **entitlement `ai` vigente (§0)** |

Errores públicos: `"local no disponible"` en GET para no filtrar existencia vs canal off vs sin entitlement — las tres situaciones devuelven la misma respuesta pública.

---

## 5. Qué no hacer

- Reusar solo `bot_enabled=false` como definición de “producto web”.
- ~~SKU / plan Stripe “solo vitrina” o entitlements `channels.storefront`~~ — **revertido 2026-10-13 (§0):** sí existe `shopping_only` y sí hay entitlement, pero es `plan.shopping_enabled` (columna tipada en `plan`), no un campo `channels` ad hoc.
- Dos flags (`storefront` + `web_orders`). (Sigue sin hacerse — esto es operativo, no cambia con §0.)
- Usar `business.features` Json como fuente de verdad del canal. (Sigue sin hacerse — la fuente de verdad del entitlement es `plan.shopping_enabled`, no JSON.)

---

## 6. Checklist backend

- [x] Migration / SQL `storefront_enabled` (+ ALTER DEFAULT true)
- [x] `DEFAULT_CONFIG` + create business (`true`)
- [x] Admin GET/PATCH config
- [x] Gate en resolución pública por slug
- [x] Tests
- [x] FEATURES `BE-15` → `disponible`; `BILL-06` → cancelado

---

## 7. Referencias de código

- Storefront: `src/services/publicStorefront.service.ts`, `publicOrders.service.ts`, `src/routes/public.routes.ts`
- Config: `src/services/businessConfig.service.ts`, `adminBusinessConfig.controller.ts`
- Bot kill switch (operativo, no comercial): `bot_enabled`
- Billing bot: `evaluateBusinessBillingAccess`
- **Entitlements comerciales (Shopping + IA, desde 2026-10-13):**
  `src/services/billing/businessCapabilities.service.ts`
  (`resolveBusinessCapabilities`, `decideShoppingCapability`,
  `decideAiCapability`) — ver [PLAN-ACCION-SHOPPING-ONLY.md](./PLAN-ACCION-SHOPPING-ONLY.md).
