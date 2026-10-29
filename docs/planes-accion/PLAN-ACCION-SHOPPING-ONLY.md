# Plan de acción — Shopping Only (entitlements de Shopping e IA)

| | |
|--|--|
| **Estado** | implementado (backend) |
| **Fecha** | 2026-10-13 |
| **Repo** | `gesty-backend` |
| **Objetivo** | Separar dos capacidades comerciales hasta ahora acopladas a "tener una suscripción": `ai_enabled` (IA conversacional) y `shopping_enabled` (Shopping). Introducir el plan `shopping_only`: Shopping sí, IA no. |
| **Depende de** | [PLAN-ACCION-STOREFRONT-CANAL.md](./PLAN-ACCION-STOREFRONT-CANAL.md) (BILL-06, reabierto por este plan), [PLAN-ACCION-STRIPE-BILLING.md](./PLAN-ACCION-STRIPE-BILLING.md) (D1-D3, reutilizados sin cambios) |

---

## 1. Resumen ejecutivo

Antes de este cambio, la IA se habilitaba únicamente por tener una
suscripción con `status` `active`/`trialing` (`evaluateBusinessBillingAccess`).
El plan contratado solo fijaba el cupo de tokens — no existía ningún
mecanismo para decir "este negocio tiene Shopping pero no IA". Shopping, por
su parte, no dependía de billing en absoluto: cualquier negocio
`is_active` + `storefront_enabled` tenía vitrina, suscripto o no.

Este plan introduce dos entitlements comerciales explícitos, tipados en el
plan (`plan.ai_enabled`, `plan.shopping_enabled`), resueltos en un único
servicio de lectura (`businessCapabilities.service.ts`) sin caché ni
sincronización a `business`. Los controles operativos existentes
(`bot_enabled`, `storefront_enabled`, `orders_enabled`) no cambian de
significado: siguen siendo necesarios, pero ya no son suficientes por sí
solos — ahora conviven con el entitlement comercial correspondiente.

## 2. Modelo de datos

```text
plan.ai_enabled        Boolean @default(true)   -- autoriza IA conversacional
plan.shopping_enabled   Boolean @default(true)   -- autoriza Shopping (vitrina + pedidos web)
```

Default `true` en ambas columnas: los planes `basic`/`pro`/`business` (y el
trial manual, que no tiene `plan_id`) conservan exactamente el mismo
comportamiento que antes de este cambio.

Plan nuevo `shopping_only`: `ai_enabled=false`, `shopping_enabled=true`,
`monthly_price_usd=null` hasta que un operador fije un precio comercial real
en `src/constants/planCatalog.ts` (no se inventó un precio). Con precio
`null`, el seed lo deja `is_active=false`: no aparece en
`/api/public/billing/plans` ni es contratable por Checkout hasta que se
complete la configuración (seed-plans + `sync-stripe-plans`).

`plan.code` **nunca** es el mecanismo de autorización — solo identifica el
plan para mostrarlo. La autorización siempre pasa por las dos columnas
booleanas.

## 3. Servicio central: `businessCapabilities.service.ts`

`src/services/billing/businessCapabilities.service.ts` expone:

- `decideShoppingCapability(sub)` / `decideAiCapability(sub, opts)`: puros,
  sin I/O, derivan la capacidad desde `subscription` (+ `plan` incluido).
  Reusados tanto por el resolver async como por `publicStorefront.service.ts`
  (que ya trae `subscription`+`plan` en su propia query, sin round-trip
  extra).
- `resolveBusinessCapabilities(businessId)`: versión con I/O para todo lo
  demás (grafo de WhatsApp, STT, visión de comprobantes, interpretación de
  promociones, enriquecimiento/embeddings de productos).

Reglas (idénticas para ambas capacidades salvo donde se indica):

1. Sin suscripción → deniega.
2. Trial (`is_trial=true`) vigente y con estado activo → concede ambas
   (sujeto, para IA, a `ai_blocked` y a cupo de tokens agotado — reglas
   preexistentes de `evaluateBusinessBillingAccess`, reutilizadas).
3. Suscripción de pago con `plan_id=null` o plan no resoluble (borrado, o
   precio de Stripe nunca mapeado) → deniega ambas explícitamente. Nunca se
   infieren capacidades de otro plan como fallback. Se deja un log
   estructurado (`[billing:capabilities] plan_unresolved`) para investigar.
4. Estado de suscripción inactivo (`past_due`, `unpaid`, `canceled`, …) →
   deniega ambas.
5. `cancel_at_period_end=true` → se conserva el acceso hasta
   `current_period_end` (no es un período de gracia nuevo: es honrar lo ya
   pagado). Pasado ese período → deniega.
6. Con un plan resuelto y suscripción vigente → cada capacidad sigue el
   booleano del plan (`ai_enabled`/`shopping_enabled`).
7. `business.ai_blocked=true` (bloqueo manual de superadmin o cupo agotado)
   es una restricción **adicional** sobre IA: solo puede denegar, nunca
   conceder por encima del plan.
8. Cualquier excepción (DB caída, etc.) → deniega ambas capacidades
   (fail-closed) y se registra el error.

## 4. Barrera de Shopping

`resolveActivePublicBusiness` y `listPublicStorefronts`
(`src/services/publicStorefront.service.ts`) — el chokepoint único del que
dependen **todas** las rutas públicas de Shopping (catálogo, categorías,
horarios, fulfillment, medios de pago, creación de pedidos, checkout,
seguimiento de pedido, push de notificaciones, reverse-geocode) — ahora
exigen, además de `is_active` + `storefront_enabled`, que
`decideShoppingCapability` conceda la capacidad. Sin ella, el contrato
público es el mismo 404 "local no disponible" que ya existía para
storefront apagado: no se distingue el motivo (no filtra estado de billing).

El webhook de Mercado Pago (`mercadoPagoWebhook.controller.ts`) resuelve el
negocio directamente por `business_id`/`payment_intent`, sin pasar por
`resolveActivePublicBusiness` — la reconciliación de pagos ya iniciados no
se ve afectada por este gate.

**No cubierto explícitamente / decisión pendiente:** si una suscripción
pierde `shopping_enabled` mientras un pedido ya placed sigue `unpaid`, el
seguimiento del pedido (`GET .../orders/:orderId`) también queda detrás del
mismo chokepoint y por tanto deja de ser visible públicamente. El pedido no
se cancela ni se altera en la base — solo deja de poder consultarse desde la
página pública mientras el negocio no tenga el entitlement. Si este
comportamiento no es el deseado, requiere una excepción explícita.

## 5. Barrera de IA

### 5.1 Grafo de WhatsApp

Nuevo nodo `aiCapabilityGateNode`
(`src/graph/nodes/gates/index.ts`), cableado en `mainGraph.ts` entre
`subscriptionAccessGate` y `capabilityAccessGate`:

```text
subscriptionAccessGate (→ send si billing inválido)
  → aiCapabilityGate (→ send con aviso fijo si !ai.allowed)
    → capabilityAccessGate → … → buildDetectionContext → { agentes/ReAct/NLP }
```

Si el gate deniega, el turno corta directo a `sendResponse` con un mensaje
fijo (sin LLM, `skipBodyHumanization: true`) y nunca alcanza
`buildDetectionContext` ni ningún nodo que invoque un modelo (detección,
agentes de reserva/onboarding/checkout/owner-assistant, ReAct, NLP).

`isOwnerAssistant` **no** exime este gate (a diferencia de
`capabilityAccessGateNode`): el dueño no puede saltarse una IA
comercialmente desautorizada.

El mensaje fijo usa `business.slug` + `env.STOREFRONT_PUBLIC_ORIGIN` para
armar un link a la tienda cuando ambos están disponibles; si no, se envía
sin link. No afirma que el negocio cerró o dejó de vender.

`persistAIMessageNode` (`src/graph/nodes/send/index.ts`) persiste ese
mensaje igual que cualquier otro (auditoría de conversación), pero no
dispara `analyzeConversationSentiment` sobre él — se guarda en
`state.aiCapabilityBlocked`, no en `skipAIPersistence` (ese flag también
suprime la persistencia del mensaje, que sí queremos conservar).

### 5.2 Camino que corre ANTES del gate: audio del dueño

`normalizeOwnerAudioNode` (transcripción STT del audio del dueño) corre
antes de `subscriptionAccessGate`/`aiCapabilityGate` en la topología del
grafo (normaliza a texto antes del gate de suscripción). Por eso
`canUseSttForBusiness` (`speechToText.service.ts`) tiene su **propio**
chequeo de `resolveBusinessCapabilities(...).ai.allowed`, además del
chequeo de billing/cuota que ya tenía.

### 5.3 Fuera del grafo

- `canUseAiForBusiness` (`adminPromotions.controller.ts`,
  `interpretPromotionHandler`): además de billing/cuota, exige
  `capabilities.ai.allowed`. Denegado → `402`.
- `generateMenuItemEnrichment` (`menuItemEnrichment.service.ts`): exige
  capacidad de IA antes de llamar a OpenAI; sin ella, lanza
  `AI_CAPABILITY_DENIED` (`adminMenuItems.controller.ts` lo mapea a `403`
  con mensaje claro). No hay versión determinista de este enriquecimiento —
  se rechaza en vez de degradar.
- `refreshMenuItemEmbedding` (`menuItemEmbedding.service.ts`): único punto
  de llamada a `getProductEmbedding` de todo el flujo admin de productos
  (crear/editar producto, cambiar precio, guardar metadata AI aprobada). El
  chequeo se centralizó ahí en vez de en cada caller, para que un futuro
  disparador de embedding no pueda olvidarlo. No borra embeddings
  existentes — simplemente no los regenera mientras el negocio no tenga IA.
- `canUseVisionForBusiness` (`paymentProofVision.service.ts`): mismo
  chequeo agregado, aunque en la práctica este flujo ya es inalcanzable
  para Shopping Only porque está corriente abajo del gate del grafo — es
  defensa en profundidad, no la barrera principal.

### 5.4 Inventario estático de llamadas a modelos

Clasificación completa (`grep` de `chat.completions.create`,
`audio.transcriptions.create`, `embeddings.create`, `llm.invoke`,
`withStructuredOutput`, `agent.invoke` y los singletons de
`src/config/llm.ts`):

| Categoría | Ejemplos | Protección |
|---|---|---|
| Detrás del gate del grafo | `detection.service`, `reactAgent`, `checkoutAgent`, `onboardingAgent`, `reservationAgent`, `ownerAssistantAgent`, `humanIntentPreflight`, `turnClassifier`, `extractPendingTurnResponse`, `promotionInterpreter` (uso conversacional vía `ctaPlanner`/dispatch), `humanizeBotBody`, `conversationSentiment`, `complementarySuggestion.ai.service`, `smartFoodRecommendations`, `openai.service` (`generateAIResponse`/`generateProductAwareResponse`) | `aiCapabilityGateNode` — ninguno es alcanzable si el gate deniega |
| Fuera del grafo, con autorización propia añadida en este plan | `speechToText.service` (STT dueño), `paymentProofVision.service` (visión comprobantes), `adminPromotions.controller` (interpretación de promos), `menuItemEnrichment.service`, `menuItemEmbedding.service` | `resolveBusinessCapabilities(...).ai.allowed` |
| Operación interna sin tenant comercial (justificado) | Scripts batch de seed/migración de embeddings (`scripts/embedding/*`) — corren fuera de una request de negocio, operados manualmente por un humano con acceso a infraestructura | Sin cambios — fuera de alcance de este plan |
| Sin ejecución en runtime / legacy | Ninguno encontrado sin uso real en el árbol de llamadas auditado | — |

## 6. Stripe, seeds y superadmin

- `scripts/billing/seed-plans.ts`: propaga `ai_enabled`/`shopping_enabled`
  desde `PAID_PLAN_CATALOG` en cada corrida (create y update) — una corrida
  posterior nunca revierte `shopping_only.ai_enabled` a `true`, porque el
  catálogo en código es la fuente. `is_active` ahora depende de que el plan
  tenga un precio (`monthly_price_usd != null`).
- `scripts/billing/sync-stripe-plans.ts`: sin cambios — ya saltaba planes
  `is_active=false` y planes sin precio USD, así que `shopping_only` queda
  afuera hasta que se le configure un precio real.
- `stripeSubscriptionSync.service.ts`: si el precio de Stripe no mapea a
  ningún plan, ya no se sincroniza nada hacia `business` (comportamiento
  preexistente) y ahora además se registra un log estructurado
  (`price_unmapped_to_plan`) para poder investigarlo.
- `superAdminBilling.controller.ts`: `ai_plan`/`ai_blocked` siguen siendo
  editables, pero documentados como no-autorizantes: `ai_blocked=true` sigue
  pudiendo denegar IA por encima del plan; nada en ese controller puede
  conceder una capacidad que el plan no otorgue.

## 7. Qué no se hizo (fuera de alcance)

- No se creó el producto/precio en Stripe (requiere `STRIPE_SECRET_KEY` y
  decisión de precio — pendiente de un operador).
- No se tocó el agente ReAct, el grafo existente (más allá de insertar un
  nodo), ni la lógica de catálogo/carrito/entrega/pagos.
- No se introdujo un framework de permisos genérico ni un proxy de OpenAI.
- No se reescribió la contabilidad de tokens (sigue sin medir todas las
  llamadas LLM — ver auditoría previa).
- No se implementó un período de gracia nuevo (solo se honra
  `cancel_at_period_end` hasta `current_period_end`, que ya era el período
  pagado).

## 8. Decisiones pendientes de confirmar

- Precio comercial real de `shopping_only` (hoy `null` en el catálogo).
- Si el seguimiento público de un pedido ya existente (`GET .../orders/:id`)
  debería seguir siendo visible aunque el negocio pierda `shopping_enabled`
  después de placed (hoy: no, por el chokepoint compartido — ver §4).
- Si corresponde un mensaje distinto al fijo genérico para el aviso de
  WhatsApp de Shopping Only (hoy: "atención automática no disponible" + link
  si hay slug + origen configurados).

## 9. Referencias de código

- `src/services/billing/businessCapabilities.service.ts`
- `src/graph/nodes/gates/index.ts` (`aiCapabilityGateNode`)
- `src/graph/mainGraph.ts`, `src/graph/routers.ts`
- `src/graph/nodes/send/index.ts` (`persistAIMessageNode`)
- `src/services/publicStorefront.service.ts`
- `src/services/ai/speechToText.service.ts`,
  `src/services/ai/paymentProofVision.service.ts`
- `src/controllers/adminPromotions.controller.ts`
- `src/services/ai/menuItemEnrichment.service.ts`,
  `src/services/ai/menuItemEmbedding.service.ts`,
  `src/controllers/adminMenuItems.controller.ts`
- `src/services/billing/stripeSubscriptionSync.service.ts`
- `src/constants/planCatalog.ts`, `prisma/sql/add_plan_capabilities.sql`,
  `scripts/billing/seed-plans.ts`

## 10. Tests

- `src/services/billing/__tests__/businessCapabilities.service.test.ts`
- `src/graph/nodes/gates/__tests__/aiCapabilityGate.test.ts`
- `src/services/__tests__/publicStorefront.service.test.ts` (extendido)
- `src/services/ai/__tests__/speechToText.service.test.ts`,
  `paymentProofVision.service.test.ts`,
  `audioTranscription.andPromotionsInterpret.test.ts` (extendidos)
- `src/services/ai/__tests__/menuItemEmbedding.service.test.ts`,
  `menuItemEnrichment.service.test.ts` (nuevos)
