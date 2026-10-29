# Contexto shopping — Web Push de seguimiento

**Para:** front `/shopping/[slug]/order/[orderId]` (repo hermano)  
**Origen:** gesty-backend  
**Fecha:** 2026-09-20  
**Plan backend:** [PLAN-ACCION-STOREFRONT-WEB-PUSH.md](./PLAN-ACCION-STOREFRONT-WEB-PUSH.md)  
**Feature:** `ORD-13`  
**Depende de:** ORD-10 (GET tracking)  
**Base API:** misma que el storefront (`/api/public/...`)

---

## Por qué

El cliente pide desde el teléfono y **sale de la web**. El poll ~8s solo funciona con la pestaña abierta. Web Push avisa del sistema cuando el pedido avanza (p. ej. “Listo para retirar”, “En camino”), aunque haya cerrado Chrome/Safari.

Identidad: **no hay login**. El `orderId` del pedido público es el secreto (igual que el GET de tracking).

---

## Qué construir en UX

1. Tras checkout exitoso **o** en `/shopping/[slug]/order/[orderId]`:
   - Si `typeof Notification !== "undefined"` y `"serviceWorker" in navigator` y `"PushManager" in window` → ofrecer CTA **“Avisame cuando avance”**.
   - Si no hay soporte → no mostrar el CTA (el poll alcanza).
2. Gesto de usuario → `Notification.requestPermission()`.
   - Si `denied` / `default` (cerró): no insistir en el mismo turno; opcional copy corto.
3. Registrar SW (si aún no está) en el **mismo origin** del shopping.
4. `GET /api/public/push/vapid-public-key` → usar `publicKey` como `applicationServerKey` (convertir base64url → `Uint8Array`).
5. `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`.
6. `POST …/orders/:orderId/push-subscription` con `{ subscription: sub.toJSON() }` (o el shape estándar endpoint + keys).
7. UI: estado “Te avisamos cuando avance” / permitir desactivar → `DELETE` con `{ endpoint }`.
8. **Poll de tracking sigue** (~8s) como respaldo con la pestaña abierta. Push no lo reemplaza.

### Service Worker (obligatorio en el origin del shopping)

| Evento | Acción |
|--------|--------|
| `push` | `event.data.json()` → `showNotification(title, { body, tag, data: { url } })` |
| `notificationclick` | `event.notification.close()` → abrir `data.url` (si es path relativo, resolver contra `self.location.origin`) |

Usar el `tag` del payload (`gesty-order-{orderId}`) para que el SO **reemplace** notificaciones viejas del mismo pedido (no apilar).

---

## API

Prefijo: `/api/public` (mismo host/base que menú y orders).

### 1. Clave VAPID

`GET /api/public/push/vapid-public-key`

**200**

```json
{ "publicKey": "<base64url VAPID public key>" }
```

**503** `{ "code": "PUSH_NOT_CONFIGURED" }` → ocultar CTA / no ofrecer push en ese entorno.

Sin auth. Misma key para todos los locales.

### 2. Registrar subscription

`POST /api/public/businesses/:slug/orders/:orderId/push-subscription`

Body:

```json
{
  "subscription": {
    "endpoint": "https://fcm.googleapis.com/fcm/send/…",
    "expirationTime": null,
    "keys": {
      "p256dh": "…",
      "auth": "…"
    }
  }
}
```

| Caso | HTTP | code |
|------|------|------|
| OK (creada o upsert) | 200 | `{ "ok": true }` |
| Pedido no existe / otro business | 404 | `ORDER_NOT_FOUND` |
| Local inactivo / storefront off | 404 | `LOCAL_UNAVAILABLE` |
| Pedido terminal (`delivered` / `cancelled`) | 409 | `ORDER_TERMINAL` |
| Body inválido | 400 | `INVALID_SUBSCRIPTION` |
| Push no configurado | 503 | `PUSH_NOT_CONFIGURED` |
| Abuso | 429 | `RATE_LIMITED` |

Auth implícita: conocer `orderId` + slug válido (igual que GET order).

### 3. Baja

`DELETE /api/public/businesses/:slug/orders/:orderId/push-subscription`

Body: `{ "endpoint": "…" }`  
**204** si ok o no existía.

---

## Payload que recibe el SW

```json
{
  "title": "Domingo · En camino",
  "body": "Pedido #A1B2C3D4 · El repartidor ya salió hacia tu dirección.",
  "url": "/shopping/{slug}/order/{orderId}",
  "orderId": "…",
  "orderRef": "A1B2C3D4",
  "slug": "…",
  "businessName": "Domingo",
  "status": "shipped",
  "tag": "gesty-order-{orderId}"
}
```

- `url` es **path relativo** al origin del shopping (salvo que el backend configure origin absoluto; el SW debe tolerar ambos: si empieza con `http`, usar tal cual; si no, `origin + url`).
- Título/body ya vienen personalizados; el SW solo muestra `title` / `body`.
- Sin `icon` (no hay logo de locales aún).
- No hay PII (nombre/teléfono del cliente); solo marca + ref + copy.

---

## Cuándo llega push (v1)

| Fulfillment | Status (BD) | Título base | Body base |
|-------------|-------------|-------------|-----------|
| TAKE_AWAY | `ready_for_pickup` (admin actual) | Listo para retirar | Acercate al mostrador. |
| TAKE_AWAY | `shipped` (legacy) | Listo para retirar | Acercate al mostrador. |
| TAKE_AWAY | `cancelled` | Pedido cancelado | Este pedido fue cancelado. |
| DELIVERY | `shipped` | En camino | El repartidor ya salió hacia tu dirección. |
| DELIVERY | `cancelled` | Pedido cancelado | Este pedido fue cancelado. |

Payload final: `{businessName} · {título base}` y `Pedido #{orderRef} · {body base}`.

**No llega** en: `placed`, `preparing`, `delivered` (MVP), ni en cambios de pago.

El front **no** tiene que filtrar status para mostrar el CTA: el backend solo empuja esos. El poll sigue mostrando todos los estados.

---

## Snippets útiles

### base64url → Uint8Array (VAPID)

```ts
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
```

### Flujo mínimo post-pedido

```ts
// 1) permission + SW
const reg = await navigator.serviceWorker.ready;
const { publicKey } = await api.get("/api/public/push/vapid-public-key");
const sub = await reg.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: urlBase64ToUint8Array(publicKey),
});
// 2) persistir en backend
await api.post(
  `/api/public/businesses/${slug}/orders/${orderId}/push-subscription`,
  { subscription: sub.toJSON() }
);
```

---

## Decisiones ya fijadas (no reabrir)

| Tema | Valor |
|------|--------|
| Auth | Solo `orderId` + slug (como tracking) |
| Quién recibe push | Solo cliente storefront; **no** admin/staff |
| Poll | Sigue; push es complemento |
| PWA “instalar app” | Opcional y **no** sustituye VAPID + SW |
| iOS | Puede requerir “Añadir a inicio”; documentar UX; API igual |
| Copy | Viene en el payload; no hardcodear títulos en el SW salvo fallback |

---

## Qué no hacer

- Pedir login / JWT para suscribirse.
- Exponer o pedir `VAPID_PRIVATE_KEY` en el front.
- Sustituir el poll por push.
- Listar subscriptions ni endpoints de otros pedidos.
- Implementar push del panel admin (fuera de alcance).

---

## Checklist front

- [ ] Feature-detect + CTA con gesto de usuario
- [ ] SW `push` + `notificationclick` (tag + url)
- [ ] GET vapid → subscribe → POST subscription
- [ ] Manejar 503 / 409 / 429 sin romper la página de tracking
- [ ] DELETE al desactivar (si hay UI)
- [ ] Poll intacto
- [ ] Probar en staging con VAPID configurado (sin keys → 503 esperado)
