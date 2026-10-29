# Plan de acción — Reverse geocode público (storefront)

| | |
|--|--|
| **Estado** | disponible |
| **Fecha** | 2026-09-20 |
| **Repo** | `gesty-backend` |
| **Objetivo** | Autocompletar calle/barrio/ciudad desde el pin del mapa (coords → textos), sin reemplazar cobertura por pin. |
| **FEATURES.md** | `ORD-12` |
| **Depende de** | [ORD-11](./PLAN-ACCION-STOREFRONT-DELIVERY.md) (pin ya es fuente de cobertura) |
| **Handoff front** | [CONTEXTO-SHOPPING-STOREFRONT-REVERSE-GEOCODE.md](./CONTEXTO-SHOPPING-STOREFRONT-REVERSE-GEOCODE.md) |
| **Origen** | gesty-admin OPS-17 |

---

## 1. Resumen

El cliente marca destino con pin/GPS. El front necesita reverse geocode para no pedirle reescribir la calle.

- Cobertura = `findCoverageZoneForPoint` (lat/lng).
- Reverse = solo UX / snapshot legible.
- Servicio **compartido** bot + storefront (`geocoding.service` + cache Prisma `geocoding_cache`).
- Forward geocode (texto → coords) y mock Rosario del bot = **fuera de alcance**.

---

## 2. Contrato

`POST /api/public/businesses/:slug/reverse-geocode`

Body: `{ "latitude": number, "longitude": number }`

200:

```json
{
  "streetAddress": "Mitre 1200",
  "neighborhood": "Centro",
  "city": "Rosario",
  "formatted": "Mitre 1200, Centro, Rosario",
  "latitude": -32.95,
  "longitude": -60.66,
  "provider": "google",
  "confidence": "high"
}
```

| Caso | Respuesta |
|------|-----------|
| OK | 200 (campos parciales null OK) |
| Coords inválidas | 400 `INVALID_COORDINATES` |
| Local inactivo / storefront off | 404 `LOCAL_UNAVAILABLE` |
| Proveedor sin resultado | **200 + nulls** (front pide tipeo manual) |
| Abuso | 429 `RATE_LIMITED` (30/min por IP) |

---

## 3. Implementación

| Pieza | Path |
|-------|------|
| Servicio + cache | `src/services/geocoding.service.ts` |
| Bot | `AddressService.reverseGeocode` → `reverseGeocodeFormatted` |
| Endpoint | `src/controllers/publicGeocoding.controller.ts` |
| Rate limit | `src/middleware/publicRateLimit.middleware.ts` |
| Ruta | `POST …/reverse-geocode` en `public.routes.ts` |

### Env

| Var | Uso |
|-----|-----|
| `GEOCODING_PROVIDER` | `google` \| `mapbox` \| `nominatim` (**default: nominatim**) |
| `GEOCODING_GOOGLE_API_KEY` / `GOOGLE_MAPS_API_KEY` | Google |
| `MAPBOX_ACCESS_TOKEN` | Mapbox |
| `GEOCODING_USER_AGENT` | Nominatim (User-Agent identificable) |

---

## 4. Checklist

- [x] Reverse real + cache
- [x] Endpoint público por slug (gates storefront)
- [x] Tests (válidas / inválidas / sin resultado / cache)
- [x] Documentar env vars (`.env.example` + este plan)
- [ ] Avisar front cuando esté en staging
