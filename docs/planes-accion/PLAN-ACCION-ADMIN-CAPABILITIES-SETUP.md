# Plan de acción — Setup de capacidades en el panel admin

| | |
|--|--|
| **Estado** | Handoff / borrador — **no ejecutar en `gesty-backend`** |
| **Fecha** | 2026-09-06 |
| **Repo** | Consumidor: panel admin (otro repo). Origen de invariantes: `gesty-backend` |
| **Objetivo** | Guiar al business admin a configurar el local sin que parezca operativo antes de tiempo; checklist y CTAs claros. |
| **FEATURES.md** | — (sin IDs en este backend; ver `BE-01`/`BE-02` como prerequisito API) |
| **Depende de** | [PLAN-ACCION-CAPABILITIES-BOOTSTRAP.md](./PLAN-ACCION-CAPABILITIES-BOOTSTRAP.md) |

---

## 1. Por qué un plan aparte

El plan de backend define **datos, validación y gates del bot**.  
Todo lo que es **flujo de configuración en la interfaz** (empty states, checklist, CTAs, copy de onboarding, cómo se muestran los toggles) pertenece a este plan / repo frontend.

---

## 2. Invariantes que el panel debe respetar (ya fijados en backend)

| # | Invariante |
|---|------------|
| I1 | Local nuevo nace con pedidos/reservas/delivery/takeaway off. |
| I2 | Métodos de pago pueden existir inactivos; activar uno **no** habilita pedidos. |
| I3 | Habilitar pedidos requiere menú + método ofrecible + delivery y/o takeaway; la API responde 400 con codes. |
| I4 | Reservas se habilitan con toggle propio; no hay “tipo de local” en create. |
| I5 | Un solo control visual de “Pedidos” (`orders_enabled`); no exponer `checkout_enabled` como toggle aparte. |
| I6 | `bot_enabled` es kill switch del canal, no el checklist de capacidades. |

---

## 3. Alcance UI (propuesta)

### 3.1 Empty states

- Pagos: “Ningún método activo — activá al menos uno antes de vender”.
- Menú vacío: bloquear o advertir el camino a “Habilitar pedidos”.
- Fulfillment: pedir elegir delivery y/o takeaway.

### 3.2 Checklist de “listo para vender”

Orden sugerido:

1. Cargar menú (≥1 ítem activo)
2. Elegir fulfillment (delivery y/o takeaway)
3. Activar ≥1 método de pago (ofrecible de verdad; online sin MP no cuenta)
4. Toggle **Habilitar pedidos**

Aparte: **Habilitar reservas** (independiente).

### 3.3 CTA suave post-pago (ex-D13 UI)

Tras activar un método de pago, si faltan menú/fulfillment/toggle pedidos:

- Mostrar banner/CTA: “Siguiente: completar setup de pedidos” / “Ya podés habilitar pedidos” cuando los prerequisitos den OK.
- **Nunca** setear `orders_enabled=true` en silencio.

### 3.4 Errores de API

Mapear codes del backend, p.ej.:

- `ORDERS_REQUIRES_MENU`
- `ORDERS_REQUIRES_PAYMENT`
- `ORDERS_REQUIRES_FULFILLMENT`

a mensajes en el toggle / toast.

### 3.5 Super-admin create (si el panel lo tiene)

Tras crear un local, no mostrar badges “operativo / toma pedidos / toma reservas” hasta que los flags lo digan.

---

## 4. Fuera de alcance de este handoff

- Cambiar defaults Prisma / seed / gates del bot → plan backend.
- Wizard largo de onboarding (puede ser fase 2 del panel).
- Tipo de local en create.

---

## 5. Criterio de éxito

1. El admin entiende qué falta para vender o reservar.
2. Ningún CTA implica que el bot ya toma pedidos si `orders_enabled` es false.
3. Los 400 del backend se ven como guía, no como error opaco.

---

## 6. Siguiente paso

Copiar/mover este documento al repo del panel y priorizar fases UI ahí cuando el backend tenga Fase 1–5 (o al menos Fase 1–2 + 5 para poderes validar el checklist).
