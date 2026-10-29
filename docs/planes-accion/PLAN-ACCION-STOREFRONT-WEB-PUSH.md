# Plan de acción — Web Push seguimiento storefront

| | |
|--|--|
| **Estado** | disponible (MVP backend) |
| **Fecha** | 2026-09-20 |
| **Repo** | `gesty-backend` |
| **Objetivo** | Avisar al cliente de la vitrina cuando el pedido avanza, aunque haya cerrado el browser. |
| **FEATURES.md** | `ORD-13` |
| **Depende de** | [ORD-10](./PLAN-ACCION-STOREFRONT-PUBLICO.md) (GET order tracking) |
| **Handoff front** | [CONTEXTO-SHOPPING-STOREFRONT-WEB-PUSH.md](./CONTEXTO-SHOPPING-STOREFRONT-WEB-PUSH.md) |
| **Origen** | gesty-admin OPS-18 |

---

## 1. Resumen

El poll ~8s solo sirve con la pestaña abierta. Web Push (VAPID + Service Worker) avisa en background.

- Identidad = `orderId` (UUID) como capability, igual que el GET de tracking.
- Solo cliente `/shopping/...`. Admin/staff siguen con socket + toast.
- Envío best-effort al cambiar `order.status`; fallos de FCM no revierten el update.

---

## 2. Contrato público

| Método | Path |
|--------|------|
| GET | `/api/public/push/vapid-public-key` → `{ publicKey }` o 503 `PUSH_NOT_CONFIGURED` |
| POST | `/api/public/businesses/:slug/orders/:orderId/push-subscription` |
| DELETE | `/api/public/businesses/:slug/orders/:orderId/push-subscription` body `{ endpoint }` |

### Estados notifiables v1

| Fulfillment | Status | Título | Body |
|-------------|--------|--------|------|
| TAKE_AWAY | `shipped` (admin) | Listo para retirar | Acercate al mostrador. |
| TAKE_AWAY | `ready_for_pickup` (legacy) | Listo para retirar | Acercate al mostrador. |
| TAKE_AWAY | `cancelled` | Pedido cancelado | Este pedido fue cancelado. |
| DELIVERY | `shipped` | En camino | El repartidor ya salió hacia tu dirección. |
| DELIVERY | `cancelled` | Pedido cancelado | Este pedido fue cancelado. |

El PATCH admin solo acepta `preparing` \| `shipped` \| `delivered`. Para retiro y envío, “salió de cocina” es el mismo valor BD `shipped`; el copy del push distingue por `fulfillmentType`.

---

## 3. Implementación

| Pieza | Path |
|-------|------|
| Tabla | `storefront_order_push_subscription` + `prisma/sql/add_storefront_order_push_subscription.sql` |
| Servicio | `src/services/storefrontOrderPush.service.ts` |
| Controller | `src/controllers/publicPush.controller.ts` |
| Rutas | `public.routes.ts` |
| Hook status | `updateAdminOrderDeliveryStatus` + cancel WA |
| Rate limit | IP (20/min) + orderId (10/min) en POST |

### Env

| Var | Uso |
|-----|-----|
| `VAPID_PUBLIC_KEY` | Expuesta al front |
| `VAPID_PRIVATE_KEY` | Firmar pushes |
| `VAPID_SUBJECT` | `mailto:…` / `https://…` |
| `STOREFRONT_PUBLIC_ORIGIN` | Opcional; URL absoluta en payload |

Generar: `npx web-push generate-vapid-keys`

---

## 4. Checklist

- [x] Modelo + SQL
- [x] GET vapid / POST+DELETE subscription
- [x] Hook status → push best-effort + limpieza terminal / 410
- [x] Tests unitarios
- [x] Env documentado en `.env.example`
- [ ] Aplicar SQL + keys en staging
- [ ] Avisar front cuando staging listo
