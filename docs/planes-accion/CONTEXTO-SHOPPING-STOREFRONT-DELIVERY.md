# Contexto shopping — Delivery en storefront

**Para:** front `/shopping/[slug]` (repo hermano)  
**Origen:** gesty-backend  
**Fecha:** 2026-09-20  
**Plan backend:** [PLAN-ACCION-STOREFRONT-DELIVERY.md](./PLAN-ACCION-STOREFRONT-DELIVERY.md)  
**Feature:** `ORD-11`

---

## Qué construir en UX

Si `GET …/fulfillment` tiene `deliveryEnabled` y/o `takeawayEnabled`, el checkout ofrece el modo correspondiente.

### Envío (delivery)

1. Usuario elige **Envío**.
2. **Mapa con pin** del destino (obligatorio). Centrar el mapa con lat/lng del **local** si el perfil/fulfillment las expone (`mapCenter` / `location` del business) — eso es solo viewport, no la dirección de entrega.
3. Campos texto: calle, depto, instrucciones (para el repartidor).
4. Al soltar el pin (o al confirmar dirección): llamar **quote** al backend.
5. UI:
   - En cobertura → mostrar fee (+ mínimo / ETA si vienen).
   - Fuera → “ups, no llegamos a esa zona” (sin habilitar Confirmar).
6. Confirmar → `POST …/orders` con `fulfillmentType: "DELIVERY"` + mismos lat/lng + textos. El total del 201 manda (revalidación server-side).

### Retiro (takeaway)

Igual que hoy: sin mapa ni quote.

---

## Decisiones ya fijadas (no reabrir)

| Tema | Valor |
|------|--------|
| Quote | Separado; el front valida contra el back antes de pedir |
| Ubicación | Pin/mapa; no geocode de texto en el backend |
| Lat/lng del local | Solo para centrar mapa / mostrar el local |
| Delivery | `deliveryEnabled` del fulfillment = propio **o** externo |
| Pago v1 | Sigue cash / pagás al recibir (sin MP en este plan) |

---

## APIs a consumir

| Método | Path | Uso |
|--------|------|-----|
| GET | `/api/public/businesses/:slug/fulfillment` | Qué modos mostrar + `mapCenter` |
| POST | `/api/public/businesses/:slug/delivery-quote` | Fee / fuera de cobertura |
| POST | `/api/public/businesses/:slug/reverse-geocode` | Pin → calle/barrio/ciudad (ORD-12; opcional UX) |
| POST | `/api/public/businesses/:slug/orders` | Crear (TAKE_AWAY o DELIVERY) |
| GET | `/api/public/businesses/:slug/orders/:orderId` | Seguimiento (`deliveryFee` + `address`) |

Contrato detallado: plan backend §4. **Backend listo (ORD-11).** Reverse geocode: [CONTEXTO-SHOPPING-STOREFRONT-REVERSE-GEOCODE](./CONTEXTO-SHOPPING-STOREFRONT-REVERSE-GEOCODE.md).

---

## Seguimiento

No asumir solo `ready_for_pickup`. Para delivery: `placed` → `preparing` → `shipped` → `delivered` (`cancelled` terminal). Destacar estados relevantes al modo elegido.

---

## Qué no hacer en el front

- Mandar solo texto de calle y esperar que el backend geocodee (hoy es mock).
- Usar lat/lng del business como si fuera la dirección del cliente.
- Confiar el `deliveryFee` del quote sin leer el total del `201`.
- Implementar Mercado Pago en este ticket.
