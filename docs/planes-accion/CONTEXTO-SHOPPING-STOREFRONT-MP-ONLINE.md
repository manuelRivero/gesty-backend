# Contexto shopping — Pago online MP en storefront

**Para:** front `/shopping/[slug]`  
**Origen:** gesty-backend  
**Fecha:** 2026-09-20  
**Plan backend:** [PLAN-ACCION-STOREFRONT-MP-ONLINE.md](./PLAN-ACCION-STOREFRONT-MP-ONLINE.md)  
**Feature:** `PAY-06`

---

## UX

1. `GET …/payment-methods` → mostrar opciones según `collectionMode`.
2. Si elige **online**: al confirmar, `POST …/orders` con `paymentMethod: "online"`.
3. Del `201` leer `checkoutUrl` y **redirect** a Mercado Pago Checkout Pro.
4. `back_urls` vuelven a `/shopping/{slug}/orders/{orderId}?payment=success|failure|pending` (requiere `STOREFRONT_PUBLIC_ORIGIN` en backend).
5. Poll `GET …/orders/:orderId` hasta `paymentStatus: "paid"`.
6. Si el usuario cierra MP sin pagar: `POST …/orders/:orderId/checkout` para recuperar el link.

Cash: igual que antes (`checkoutUrl: null`, pagás en mostrador / al recibir).

---

## Contrato breve

```json
// POST orders (online)
{ "paymentMethod": "online", "customer": {…}, "items": […] }

// 201
{ "orderId": "…", "paymentStatus": "unpaid", "paymentMethod": "online", "checkoutUrl": "https://…", "total": "…" }
```

No confiar el total del quote del carrito: el `201.total` manda (incluye ajuste de método si hay).

---

## Qué no hacer

- Mandar `transfer` por este canal.
- Asumir que online siempre está (mirar GET payment-methods).
- Inventar Brick/Elements: solo redirect Checkout Pro.
