# Plan de acción — Delivery en storefront público

| | |
|--|--|
| **Estado** | disponible (Fases A–D) |
| **Fecha** | 2026-09-20 |
| **Repo** | `gesty-backend` (quote + POST DELIVERY); mapa/pin = **front shopping** (repo hermano) |
| **Objetivo** | Que `/shopping/[slug]` ofrezca **retiro y /o envío** según config del local, con quote de cobertura/fee antes de confirmar. Pago: cash unpaid y/o MP online (PAY-06). |
| **FEATURES.md** | `ORD-11` |
| **Depende de** | [ORD-10](./PLAN-ACCION-STOREFRONT-PUBLICO.md), [BE-15 canal](./PLAN-ACCION-STOREFRONT-CANAL.md), ORD-04 zonas admin |
| **Handoff front** | [CONTEXTO-SHOPPING-STOREFRONT-DELIVERY.md](./CONTEXTO-SHOPPING-STOREFRONT-DELIVERY.md) |

---

## 1. Resumen ejecutivo

Hoy el POST público fuerza `TAKE_AWAY` y solo gatea `takeaway_enabled`. El GET fulfillment ya expone `deliveryEnabled`, pero el backend no cumple el contrato de envío.

El bot ya tiene zonas (`business_coverage_zone`), fee, mínimo y `customer_address`. El storefront debe **reusar esa geometría**, no inventar otro modelo.

**Fuera de alcance de este plan:** Mercado Pago / pagos online, geocode real (Google/OSM).

---

## 2. Decisiones Fase 0 — **FIJADAS**

| # | Decisión | Resolución |
|---|----------|------------|
| D1 | Quote | **Endpoint separado** de preview. El front valida antes de confirmar → fee o “fuera de cobertura”. |
| D2 | Dirección en web | **Mapa + pin** (lat/lng del **destino**). UX esperada. No depender de geocode backend. |
| D3 | Texto de calle | Complemento para ticket/repartidor (calle, depto, notas). **No** fuente de cobertura. |
| D4 | Lat/lng del business | Solo **origen del local** (centrar mapa, perfil). **Nunca** proxy del destino del cliente. |
| D5 | Geocode mock (Rosario) | **No usar** en storefront. El mock también afecta al bot en direcciones por texto; fix real = integración aparte. |
| D6 | Persistencia | Al confirmar DELIVERY: **upsert `customer_address`** (con `location`) + **`delivery_address_snapshot`** en la orden (igual espíritu que el bot). |
| D7 | Flag de canal | No hay `web_delivery_enabled`. Mismo `storefront_enabled`. Modo = `delivery_enabled` / `takeaway_enabled`. |
| D8 | External delivery | Cuenta como envío en web: `deliveryEnabled = delivery \|\| external` (mismo criterio que el bot). Flags excluyentes en config. |
| D9 | Pago | Sigue `cash` + `unpaid` (“pagás al recibir” / mostrador). MP = plan futuro. |
| D10 | Revalidación | El POST **no confía** el fee del quote: vuelve a calcular zona/fee/mínimo con los mismos lat/lng. |
| D11 | Fail cerrado | Sin zona / sin lat/lng → error explícito. **No** reutilizar el “fee 0 silencioso” de `resolveDeliveryContext` cuando falta address. |

---

## 3. Flujo UX / API

```text
fulfillment: takeaway | delivery (según GET …/fulfillment)
                    │
                    ├─ TAKE_AWAY → POST orders (como hoy)
                    │
                    └─ DELIVERY
                         │
                         ├─ Mapa: pin destino (lat/lng) + calle/depto
                         ├─ POST …/delivery-quote
                         │     → inCoverage + fee + min + ETA
                         │     → o OUT_OF_COVERAGE
                         └─ POST …/orders (revalida + persiste address + crea orden)
```

---

## 4. Contrato sugerido (bajo `/api/public`)

### 4.1 Quote

`POST /api/public/businesses/:slug/delivery-quote`

Body (mínimo):

```json
{
  "latitude": -32.95,
  "longitude": -60.66,
  "itemsSubtotal": "4500.00"
}
```

`itemsSubtotal` opcional pero útil para `minOrderMet` en UI. El servidor puede recalcular mínimo contra el subtotal enviado **solo como hint**; al crear la orden el mínimo se mide con precios de servidor.

Respuesta OK:

```json
{
  "inCoverage": true,
  "deliveryFee": "800.00",
  "minOrderAmount": "5000.00",
  "minOrderMet": false,
  "estimatedMinutes": 40,
  "zoneId": "uuid",
  "zoneName": "Centro"
}
```

Fuera de cobertura: `200` con `inCoverage: false` **o** `400` `OUT_OF_COVERAGE` — preferencia: **200 + `inCoverage: false`** para que el front muestre “ups” sin tratarlo como error de red. Si el local no tiene delivery: `403` `DELIVERY_DISABLED`.

### 4.2 Extender POST orders

`fulfillmentType`: `"TAKE_AWAY" | "DELIVERY"`.

Si `DELIVERY`, exigir:

```json
{
  "fulfillmentType": "DELIVERY",
  "address": {
    "latitude": -32.95,
    "longitude": -60.66,
    "streetAddress": "Mitre 1200",
    "apartment": "3B",
    "neighborhood": null,
    "city": "Rosario",
    "instructions": "Timbre roto"
  }
}
```

Gates:

| Modo | Flag |
|------|------|
| TAKE_AWAY | `takeaway_enabled` |
| DELIVERY | `delivery_enabled` (+ storefront + orders + horario como hoy) |

Orden: `fulfillment_type=DELIVERY`, `delivery_fee`, `customer_address_id`, snapshot, total con fee.

### 4.3 GET order / 201

Ampliar `PublicOrderView` (opcional pero útil):

- `deliveryFee`
- `address` (desde snapshot: calle, depto, etc.)
- `estimatedMinutes` si se congeló o se puede omitir en v1

Estados: el front no asume solo `ready_for_pickup`; para delivery importan `preparing` → `shipped` → `delivered`.

### 4.4 GET fulfillment (ajuste menor)

Documentar / eventualmente añadir campos claros:

- `takeawayEnabled` / `deliveryEnabled` (ya existen)
- `mapCenter`: `{ latitude, longitude }` desde `business` (para centrar el mapa del pin) — si null, el front usa default de ciudad

---

## 5. Fases de implementación (backend)

| Fase | Qué | Notas |
|------|-----|--------|
| **A** | `POST …/delivery-quote` | hecho — `findCoverageZoneForPoint`; hard-fail sin zona; sin geocode |
| **B** | POST orders `DELIVERY` | hecho — gates, upsert address+location, snapshot, fee, mínimo, tests |
| **C** | Ampliar GET/201 view | hecho — `deliveryFee` + `address` |
| **D** | `mapCenter` en fulfillment | hecho — lat/lng del business |
| **Después** | Geocode real compartido bot+web; MP online | Otros planes |

---

## 6. Qué reutilizar / qué no

| Reutilizar | Evitar |
|------------|--------|
| `findCoverageZoneForPoint` | `geocode()` mock |
| Patrón snapshot de `createOrderFromDraft` | `resolveDeliveryContext` sin `location` (fee 0 silencioso) |
| `computeOrderPricing({ deliveryFee })` | `external_delivery_enabled` en web v1 |
| `findOrCreateCustomer` por teléfono | Confiar fee del client |

---

## 7. Checklist backend

- [x] Quote endpoint + errores (`DELIVERY_DISABLED`, `inCoverage: false`, `INVALID_COORDINATES`)
- [x] POST acepta `DELIVERY` + address lat/lng
- [x] Upsert `customer_address` con geography + zona
- [x] `delivery_fee` + mínimo revalidados
- [x] Snapshot en orden
- [x] Tests (en zona / fuera / takeaway sin regresión)
- [x] Actualizar PLAN-ACCION-STOREFRONT-PUBLICO gaps
- [x] FEATURES `ORD-11` → `disponible`

---

## 8. Nota sobre el bot y el geocode

El mock Rosario **también** afecta al bot cuando la dirección entra por texto. Este plan **no** lo arregla; la web lo elude con pin. Geocode real = iniciativa transversal (bot + web texto libre) en otro plan.
