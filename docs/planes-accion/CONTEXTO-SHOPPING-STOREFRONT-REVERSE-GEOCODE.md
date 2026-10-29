# Contexto shopping — Reverse geocode (pin → calle)

**Para:** front `/shopping/[slug]` (repo hermano)  
**Origen:** gesty-backend  
**Fecha:** 2026-09-20  
**Plan backend:** [PLAN-ACCION-STOREFRONT-REVERSE-GEOCODE.md](./PLAN-ACCION-STOREFRONT-REVERSE-GEOCODE.md)  
**Feature:** `ORD-12`  
**Depende de:** ORD-11 (quote + pin lat/lng)

---

## Qué construir en UX

1. Usuario coloca pin (click en mapa o “Usar mi ubicación”).
2. Front llama reverse-geocode con debounce ~300 ms al soltar el pin.
3. Autocompleta `streetAddress` (+ `city` / `neighborhood` si vienen).
4. **Depto e instrucciones siguen manuales.**
5. Usuario puede editar la calle antes de confirmar.
6. Quote / POST orders **igual que ORD-11**: lat/lng del pin + textos (cobertura no usa el reverse).

Si la respuesta trae `streetAddress: null` / `formatted: ""` → pedir tipeo manual (no tratarlo como error de red).

---

## API

| Método | Path |
|--------|------|
| POST | `/api/public/businesses/:slug/reverse-geocode` |

### Body

```json
{ "latitude": -32.95, "longitude": -60.66 }
```

### 200

```json
{
  "streetAddress": "Mitre 1200",
  "neighborhood": "Centro",
  "city": "Rosario",
  "formatted": "Mitre 1200, Centro, Rosario",
  "latitude": -32.95,
  "longitude": -60.66,
  "provider": "nominatim",
  "confidence": "medium"
}
```

`provider` / `confidence` pueden ser `null`. Campos de texto pueden ser `null`. Backend default: Nominatim (sin key en el front).

### Errores

| HTTP | code |
|------|------|
| 400 | `INVALID_COORDINATES` / `INVALID_BODY` |
| 404 | `LOCAL_UNAVAILABLE` |
| 429 | `RATE_LIMITED` |

---

## Qué no hacer

- Usar reverse para decidir cobertura (sigue siendo el pin + `delivery-quote`).
- Pedir forward geocode (texto → pin) en este ticket.
- Meter API keys de Google/Mapbox en el front.
