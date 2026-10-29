# Contexto admin — Canal storefront (`storefront_enabled`)

| | |
|--|--|
| **Para** | gesty-admin (agente / repo panel) |
| **Origen** | gesty-backend |
| **Fecha** | 2026-09-20 |
| **Estado backend** | `BE-15` **disponible**. Incluido en todos los planes; **sin** SKU “solo web” (`BILL-06` cancelado). |
| **Plan backend** | [PLAN-ACCION-STOREFRONT-CANAL.md](./PLAN-ACCION-STOREFRONT-CANAL.md) |
| **Storefront API** | [PLAN-ACCION-STOREFRONT-PUBLICO.md](./PLAN-ACCION-STOREFRONT-PUBLICO.md) (`ORD-10`) |
| **Capabilities UI** | [PLAN-ACCION-ADMIN-CAPABILITIES-SETUP.md](./PLAN-ACCION-ADMIN-CAPABILITIES-SETUP.md) |

---

## 1. Qué cambió (backend)

El shopping público (`/shopping/[slug]`) es un **canal aparte** del bot WhatsApp. Para publicarlo: `is_active` + `storefront_enabled` + `slug`.

| Campo | Tabla | Default | Rol |
|-------|--------|---------|-----|
| `storefront_enabled` | `business_config` | `true` | Kill switch del canal web (vitrina **y** pedidos juntos). Incluido en el plan; el admin lo apaga. |
| `bot_enabled` | `business_config` | `true` | Kill switch WhatsApp/IA — **independiente** |
| `orders_enabled` / `takeaway_enabled` | `business_config` | `false` | Capacidad operativa de pedidos (sin cambio) |
| `slug` | `business` | null | Clave de URL pública |

**Un solo flag** cubre menú + pedidos web. No hay `web_orders_enabled` ni toggle “solo carta”.

Locales nuevos nacen con storefront **on**. Sin slug, igual no hay URL compartible.

---

## 2. Trabajo del panel

### Objetivo UI

1. Toggle **Tienda web / Storefront** ↔ `storefront_enabled` (junto a `bot_enabled` o en Settings → Canales). Default on → el copy del off es “apagaste la tienda”, no “contratá un plan”.
2. Mostrar / copiar el link público cuando haya `slug` + storefront on.
3. Si storefront on pero pedidos incompletos: checklist de capacidades (mismo patrón BE-01), no inventar segundo toggle.

### Copy sugerido

> Publicá el menú y los pedidos de autoservicio en la web. Incluido en tu plan; el cobro es en el mostrador / al recibir.

### Empty states

| Situación | Mensaje orientativo |
|-----------|---------------------|
| `storefront_enabled=false` | “Activá la tienda web para compartir el link del menú.” |
| on, sin `slug` | “Definí un slug del local para la URL pública.” |
| on + slug, pero sin pedidos listos | Checklist: menú disponible, `orders_enabled`, fulfillment (reusar capabilities setup). |
| off | No mostrar el link como “activo”; el público recibe 404. |

---

## 3. Contrato API (exacto)

Auth: JWT admin (`OWNER` | `ADMIN`). Prefijo: `/api/admin`.

### 3.1 Config

| Método | Path | Notas |
|--------|------|-------|
| `GET` | `/api/admin/config` | Incluye `storefront_enabled: boolean`. |
| `PATCH` | `/api/admin/config` | Body parcial: `{ "storefront_enabled": true \| false }`. |
| `POST` | `/api/admin/config` | Idem upsert. |

```json
{
  "bot_enabled": true,
  "storefront_enabled": true,
  "orders_enabled": false,
  "takeaway_enabled": false,
  "checkout_enabled": false,
  "bot_personality": { "id": "…", "slug": "neutral", "name": "…" }
}
```

`storefront_enabled` **no** tiene prerequisitos propios: se puede dejar la vitrina on sin pedidos (solo carta / 403 en POST).

### 3.2 Slug del local

| Método | Path | Campo |
|--------|------|-------|
| `GET` | `/api/admin/business` | `slug: string \| null` |
| `PATCH` | `/api/admin/business` | `{ "slug": "mi-local" }` o `null` |

### 3.3 URL pública

Forma: `/shopping/{slug}` en el front de vitrina (ORD-10). El backend **no** arma la URL.

### 3.4 Gates públicos (para entender; no es trabajo admin)

Si `storefront_enabled=false` (o `is_active=false`): 404 `{ error: "local no disponible" }`.

Pedidos web además: `orders_enabled` + fulfillment + horario.

---

## 4. Matriz producto

| Producto | `bot_enabled` | `storefront_enabled` |
|----------|---------------|----------------------|
| Solo bot | `true` | `false` |
| Solo web | `false` | `true` |
| Full (default create) | `true` | `true` |

Ambos toggles son editables **sin** mirar el plan Stripe. No hay entitlement de canales.

---

## 5. Tipos / cliente HTTP

1. Tipo config: `storefront_enabled: boolean` (default `true` en backend).
2. `GET/PATCH config`: leer y enviar el campo.
3. UI Settings / Canales: toggle + link + empty states.
4. Editor de slug si falta.

---

## 6. Qué no hacer

- Segundo toggle “solo menú sin pedidos”.
- Usar `bot_enabled=false` como “producto web”.
- Gatear el toggle por plan/billing / CTA “cambiar de plan” por canal.
- Inventar cobro Stripe “solo vitrina”.
- Llamar endpoints públicos con JWT de admin para “probar”.

---

## 7. Criterio de listo (panel)

- [ ] Toggle persiste vía `PATCH /api/admin/config` `{ storefront_enabled }`.
- [ ] `GET /api/admin/config` refleja el valor (default on en locales nuevos).
- [ ] Con off: copy/empty state; link no se presenta como vivo.
- [ ] Con on + slug: URL `/shopping/{slug}` copiable.
- [ ] Con on pero sin pedidos: checklist capabilities.
- [ ] `bot_enabled` y `storefront_enabled` combinables en la matriz §4.
