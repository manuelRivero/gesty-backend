# Plan de acción — Pago online MP en storefront

| | |
|--|--|
| **Estado** | disponible (PAY-06) |
| **Fecha** | 2026-09-20 |
| **Repo** | `gesty-backend`; redirect UI = front shopping |
| **Objetivo** | Que `/shopping/[slug]` ofrezca **Mercado Pago** cuando el local tenga `online` activo + provider MP. Cash sigue siendo opción de mostrador. |
| **FEATURES.md** | `PAY-06` |
| **Depende de** | ORD-10, PAY-01, PAY-02, PAY-04 |
| **Handoff front** | [CONTEXTO-SHOPPING-STOREFRONT-MP-ONLINE.md](./CONTEXTO-SHOPPING-STOREFRONT-MP-ONLINE.md) |

---

## Decisiones

| # | Resolución |
|---|------------|
| Ciclo | Orden primero (`placed` + `unpaid`) → preference → webhook marca `paid` |
| Métodos | Solo `cash` \| `online` (transfer fuera) |
| Disponibilidad online | `payment_method_config.online` activo ∧ provider MP |
| `external_reference` | `orderId` (no draft) |
| Re-link | `POST …/orders/:orderId/checkout` |
| `back_urls` | `{STOREFRONT_PUBLIC_ORIGIN}/shopping/{slug}/orders/{orderId}?payment=success\|failure\|pending`. Sin origin → omitir (no `/payment/success`). Helper `storefrontBackUrls` en create + re-link. |

---

## API

| Método | Path | Notas |
|--------|------|-------|
| GET | `/businesses/:slug/payment-methods` | cash y/o online; `collectionMode`: `pay_at_counter` \| `pay_online` \| `pay_at_counter_or_online` |
| POST | `/businesses/:slug/orders` | `paymentMethod: "cash" \| "online"`; 201 incluye `checkoutUrl` si online |
| POST | `/businesses/:slug/orders/:orderId/checkout` | Reusa/regen `init_point` si unpaid online |
| GET | `/businesses/:slug/orders/:orderId` | `checkoutUrl` si unpaid online |

Errores: `ONLINE_PAYMENT_UNAVAILABLE` (403), `CHECKOUT_UNAVAILABLE` (503), `ALREADY_PAID` (409).

---

## Evidencia

- Schema: `payment_intent.draft_order_id` nullable; índice `order_id+status`
- `createStorefrontOnlineCheckout` / `handleApprovedStorefrontPayment` en `payment.service.ts`
- Webhook dual path en `mercadoPagoWebhook.controller.ts`
- SQL: `prisma/sql/payment_intent_draft_order_nullable.sql`

---

## Checklist

- [x] Schema + SQL
- [x] GET payment-methods
- [x] POST orders online + checkoutUrl
- [x] POST checkout re-link
- [x] Webhook storefront
- [x] `back_urls` dinámicas por slug/orderId (+ omitir sin origin)
- [x] Tests + FEATURES + contexto shopping
