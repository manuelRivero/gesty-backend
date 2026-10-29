# Plan de acción — Storefront público por slug

## Objetivo

Exponer una API pública (sin JWT) para que el front `/shopping/[slug]` pueda renderizar la vitrina de un local como PedidosYa: perfil, menú, horario/fulfillment/métodos de pago, y confirmar pedido de **autoservicio en local** con cobro manual en mostrador. El **slug** es la clave de tenant en URLs compartibles.

## Estado

| Fase | Qué | Estado |
|------|-----|--------|
| A | `GET /api/public/businesses/:slug` (perfil) | hecho |
| B | Menú: categories / items / menú unificado | hecho |
| C | hours / fulfillment / payment-methods | hecho |
| D | `POST /api/public/businesses/:slug/orders` | hecho |
| E | `GET …/orders/:orderId` seguimiento (poll) | hecho |

## Contrato (montado bajo `/api/public`)

| Método | Path | Notas |
|--------|------|-------|
| GET | `/businesses/:slug` | Perfil; 404 `"local no disponible"` si no existe, `is_active=false` o `storefront_enabled=false`. También acepta UUID por compat. |
| GET | `/businesses/:slug/menu` | `{ business, categories, items }` — preferido en mobile |
| GET | `/businesses/:slug/menu/categories` | Tags horizontales |
| GET | `/businesses/:slug/menu/items` | Query: `categoryId`, `availableOnly` (default `true`) |
| GET | `/businesses/:slug/hours` | Horarios + `isOpen` / `nextOpenText` |
| GET | `/businesses/:slug/fulfillment` | Delivery / takeaway / checkout flags + `mapCenter` (lat/lng del local) |
| GET | `/businesses/:slug/payment-methods` | Solo `cash` + `collectionMode: pay_at_counter` (sin MP/transfer) |
| POST | `/businesses/:slug/delivery-quote` | Cobertura/fee por pin (ORD-11) |
| POST | `/businesses/:slug/orders` | Pedido autoservicio TAKE_AWAY o DELIVERY; ver abajo |
| GET | `/businesses/:slug/orders/:orderId` | Misma forma que el 201; poll ~8s. Sin JWT (`orderId` = secreto). 404 si no existe / no es del slug. |

Ítem storefront: `id`, `name`, `description`, `price`, `currencyCode`, `imageUrl`, `categoryId`, `available`, `featured?`, `variations?`, `discount?`.

## POST orders — autoservicio / mostrador

**Aislado de WhatsApp y Mercado Pago.** No usa `draft_order`, `conversation` ni `payment_intent`.

| Campo orden | Valor fijo |
|-------------|------------|
| `status` | `placed` |
| `payment_status` | `unpaid` |
| `payment_method` | `cash` |
| `fulfillment_type` | `TAKE_AWAY` \| `DELIVERY` |
| `conversation_id` | `null` |

### Body

```json
{
  "customer": { "name": "Juan", "phone": "+54 9 11 1234-5678" },
  "items": [
    { "menuItemId": "uuid", "quantity": 2, "variation": "Roquefort", "notes": "sin cebolla" }
  ],
  "fulfillmentType": "TAKE_AWAY",
  "paymentMethod": "cash",
  "notes": "opcional pedido"
}
```

Para `DELIVERY` (ORD-11): `address` con `latitude`/`longitude` (pin) + textos. Ver [PLAN-ACCION-STOREFRONT-DELIVERY](./PLAN-ACCION-STOREFRONT-DELIVERY.md).

- Precios y disponibilidad se **revalidan en servidor** (no confiar en el total del front).
- Variaciones: gate con `matchVariation` (igual que el bot).
- Gates: `storefront_enabled` (canal), `orders_enabled`, `takeaway_enabled` / `delivery_enabled`, horario (`orders_when_closed` si cerrado).
- Emite `order.created` al panel admin.

### Errores útiles

`LOCAL_UNAVAILABLE` (404), `ORDERS_DISABLED` / `TAKEAWAY_DISABLED` / `DELIVERY_DISABLED` / `CLOSED` (403), `ITEM_UNAVAILABLE` / `VARIATION_REQUIRED` / `INVALID_PHONE` / `OUT_OF_COVERAGE` / `MIN_ORDER_NOT_MET` (400).

## GET orders/:orderId — seguimiento (Fase E)

Misma forma `PublicOrderView` que el `201` (`deliveryFee` + `address` si DELIVERY). El front guarda el snapshot local y hace poll.

Estados takeaway: `placed` → `preparing` → `ready_for_pickup` → `delivered` (`cancelled` terminal).  
Estados delivery: `placed` → `preparing` → `shipped` → `delivered`.

## Gates de canal (BE-15)

Además de `is_active`, toda la API pública del storefront exige `business_config.storefront_enabled=true`. Si está off → mismo 404 `"local no disponible"` (no filtra existencia vs canal). Independiente de `bot_enabled`. Detalle: [PLAN-ACCION-STOREFRONT-CANAL](./PLAN-ACCION-STOREFRONT-CANAL.md).

## Gaps conocidos

- No hay `logo`/`image` en `business` → `imageUrl: null` en perfil.
- Online/MP: [PLAN-ACCION-STOREFRONT-MP-ONLINE](./PLAN-ACCION-STOREFRONT-MP-ONLINE.md) (`PAY-06`) — **hecho**. Delivery web: [PLAN-ACCION-STOREFRONT-DELIVERY](./PLAN-ACCION-STOREFRONT-DELIVERY.md) (`ORD-11`) — **hecho**.

## Evidencia en código

- `src/services/publicStorefront.service.ts`
- `src/services/publicOrders.service.ts`
- `src/controllers/publicOrders.controller.ts`
- `src/routes/public.routes.ts`
- Tests: `src/services/__tests__/publicStorefront.service.test.ts`, `publicOrders.service.test.ts`

## Feature

`ORD-10` en `docs/FEATURES.md` (+ `ORD-11` delivery).

## Siguiente

- Canal storefront (incluido en plan): [PLAN-ACCION-STOREFRONT-CANAL.md](./PLAN-ACCION-STOREFRONT-CANAL.md) (`BE-15`; `BILL-06` cancelado)
- Delivery web: [PLAN-ACCION-STOREFRONT-DELIVERY.md](./PLAN-ACCION-STOREFRONT-DELIVERY.md) (`ORD-11`) · [CONTEXTO-SHOPPING](./CONTEXTO-SHOPPING-STOREFRONT-DELIVERY.md) — **backend hecho**; falta UX mapa/pin en front shopping.
