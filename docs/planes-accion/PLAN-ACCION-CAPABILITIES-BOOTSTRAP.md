# Plan de acción — Bootstrap limpio de capacidades (backend)

| | |
|--|--|
| **Estado** | Fases 1–5 implementadas (Fase 6 opcional pendiente) |
| **Fecha** | 2026-09-05 (actualizado 2026-09-06) |
| **Repo** | `gesty-backend` |
| **Objetivo** | Un negocio nuevo no nace “listo para vender/reservar”; flags + prerequisitos en API; el bot no empuja objetivos imposibles. |
| **FEATURES.md** | `BE-01`, `BE-02` |

**Fuera de este plan:** UI del panel (checklist, CTAs, empty states). Handoff: [PLAN-ACCION-ADMIN-CAPABILITIES-SETUP.md](./PLAN-ACCION-ADMIN-CAPABILITIES-SETUP.md).

**Contexto:** el seed de métodos de pago (`cash`+`online` activos) y los defaults de `business_config` sirvieron para locales de prueba ya armados. En SaaS self-serve es un error de producto a nivel de **datos y runtime**, no solo de UI.

---

## 1. Resumen ejecutivo

### Problema hoy

| Área | Comportamiento actual | Efecto |
|------|----------------------|--------|
| `POST` super-admin create business | Crea `business` + `business_config` vacío + owner + trial | Flags vienen de defaults Prisma “todo on” |
| Defaults `business_config` | `orders_enabled`, `checkout_enabled`, `reservations_enabled`, `delivery_enabled` = **true** | Nace “listo” para pedir y reservar |
| Seed pagos | `ensureDefaultPaymentMethodConfigs`: cash+online **activos** | Primer listado/checkout **inventa** métodos activos |
| Validación admin pagos | ≥1 método activo obligatorio | Impide “todo apagado”; empuja a seed agresivo |
| `orders_enabled` / `checkout_enabled` | Existen en schema/API | **No gatean** el híbrido ni el grafo |
| `reservations_enabled` | Gate en `start_reservation_session` + small-talk | Único flag de capacidad cableado |
| Gate bot por capacidades | No existe | Solo billing y `bot_enabled` |

### Solución (este repo)

1. Defaults + create limpios.
2. Seed de pagos sin activar métodos.
3. Validación en API al activar `orders_enabled` (menú, pago ofrecible, fulfillment).
4. Gates de bot: total y selectivo (`canOrder`).
5. Invariante: mutaciones de pago **no** setean `orders_enabled`.

### Decisiones Fase 0 — **FIJADAS** (backend)

| # | Decisión | Resolución |
|---|----------|------------|
| D1 | Defaults create / `DEFAULT_CONFIG` / Prisma | `orders_enabled=false`, `checkout_enabled=false`, `reservations_enabled=false`, `delivery_enabled=false`, `takeaway_enabled=false`. `bot_enabled=true` (D11). |
| D2 | Seed `payment_method_config` | Filas del catálogo con **`is_active=false`**. Nunca auto-activar. |
| D3 | Validación “≥1 activo” | Permitir **0 activos** al guardar métodos. Exigir ≥1 **ofrecible** solo al activar `orders_enabled` / en `canOrder`. |
| D4 | “tiene pago” | `listOfferedPaymentMethods(...).length > 0`. |
| D5 | “tiene reservas” | `reservations_enabled === true`. Mesas al activar: fuera de v1. |
| D6 | Prerequisito menú | Al `orders_enabled=true` y en `canOrder`: ≥1 `menu_item` activo. |
| D7 | Gate total | Sin `canOrder` y sin reservas → `earlyExit` (copy §2.1, canal WhatsApp). |
| D8 | Gate selectivo pedidos | Reservas on + `!canOrder` → tools/CTAs de pedido bloqueados (ADR-0002). |
| D9 | Negocios existentes | No migrar flags en masa. |
| D10 | Quién prende el flag | Solo vía API de config (admin). Sin auto-enable al crear ítem de menú ni al activar un método de pago. |
| D11 | `bot_enabled` | `true` al create + capability gate. Kill switch del canal ≠ capacidades. |
| D12 | Fulfillment | `delivery_enabled` y `takeaway_enabled` false al create. Al `orders_enabled=true` exigir **al menos uno**. |
| D13 | Pago → pedidos (invariante API) | Activar/crear/actualizar un método de pago **no** modifica `orders_enabled`. Son campos independientes en backend. |
| D14 | Tipo de local | No existe en create. Default `reservations_enabled=false`. |
| D15 | Copy **cliente** (WhatsApp) | §2.1. (Copy de UI admin → plan panel.) |
| D16 | `checkout_enabled` | Sync en upsert: sigue a `orders_enabled`. Sin semántica aparte en runtime. |
| D17 | Owner assistant | Exento del capability gate. |

---

## 2. Matriz de capacidades (runtime)

- `hasPayment = listOfferedPaymentMethods(...).length > 0`
- `hasReservations = reservations_enabled`
- `hasFulfillment = delivery_enabled || takeaway_enabled`
- `hasActiveMenu =` ≥1 `menu_item` activo
- `canOrder = orders_enabled && hasPayment && hasActiveMenu && hasFulfillment`

| hasReservations | canOrder | Bot |
|-----------------|----------|-----|
| false | false | Bloqueo total |
| true | false | Solo reservas |
| false | true | Solo pedidos |
| true | true | Completo |

### 2.1 Copy al cliente WhatsApp (D15)

**Bloqueo total:**

```
Asistente · 🛠️
Este local todavía está configurando el asistente.
Por ahora no podemos tomar pedidos ni reservas por este chat.
```

**Solo-reservas** (rechazo de tool/pedido):

```
Por ahora este local solo toma reservas por este chat, no pedidos a domicilio ni para llevar.
Si querés una mesa, pedime reservar.
```

---

## 3. Arquitectura (backend)

```
POST super-admin create
  → business + business_config (D1) + owner + trial
  → payment seed is_active=false (D2)
  → no asume menú / cobro / fulfillment

API admin config
  → PATCH orders_enabled=true: valida menú + pago ofrecible + fulfillment
  → mutaciones payment_method_config: no tocan orders_enabled (D13)
  → errores 400 con codes estables (contrato para el panel)

Bot mainGraph
  subscriptionAccessGate
  → capabilityAccessGate          // D7; skip owner D17
  → … híbrido / tools gated       // D8 canOrder
```

Evaluador: `evaluateBusinessCapabilityAccess` →  
`{ mode: 'full' | 'reservations_only' | 'orders_only' | 'blocked', reason, message }`

**Contrato mínimo hacia el panel** (lo consume el otro plan; no se implementa UI acá):

- Defaults limpios en create.
- 400 al habilitar pedidos sin prerequisitos (`code` + `message`).
- Listado de métodos puede devolver filas inactivas / catálogo.
- Activar pago no cambia `orders_enabled`.

---

## 4. Fases

| Fase | Entrega | Estado |
|------|---------|--------|
| **0** | Decisiones D1–D17 | **Cerrada** |
| **1** | Defaults create + schema + `DEFAULT_CONFIG` + sync checkout | **Hecho** |
| **2** | Seed pagos inactivo + allow 0 activos | **Hecho** |
| **3** | Cablear `canOrder` en tools / CTAs / dispatch / welcome | **Hecho** |
| **4** | `capabilityAccessGateNode` | **Hecho** |
| **5** | Validación API menú + fulfillment + pago al enable orders | **Hecho** |
| **6** | (Opcional) Script auditoría legacy + mesas al activar reservas | Opcional |

### Fuera de alcance de **este** plan

- Cualquier UX del panel (checklist, CTAs, empty states, toggles visuales).
- Campo “tipo de local”.
- Auto-enable de flags.
- Migración destructiva de locales en prod.
- Billing/Stripe.
- Plan del panel: [PLAN-ACCION-ADMIN-CAPABILITIES-SETUP.md](./PLAN-ACCION-ADMIN-CAPABILITIES-SETUP.md).

---

## 5. Detalle por fase

### Fase 1 — Defaults limpios

- `prisma/schema.prisma` + migración de **defaults de columna** (sin UPDATE masivo).
- `businessConfig.service.ts` — `DEFAULT_CONFIG` + D16.
- `superAdminCreateBusiness.service.ts` — create explícito.
- Tests de create.

### Fase 2 — Seed + validación de métodos

- `paymentMethods.service.ts` — seed `isActive: false`.
- `paymentMethodRules.ts` — permitir 0 activos.
- Tests.

### Fase 3 — Bloqueo de pedidos en runtime

- Gates ADR-0002: `add_cart_item`, `start_checkout_session`, ADD_ITEM interactive, etc.
- Welcome sin CTA de pedido si `!canOrder`.

### Fase 4 — Gate total en grafo

- `evaluateBusinessCapabilityAccess.service.ts`
- Nodo tras `subscriptionAccessGate`; `earlyExit: 'capabilities_blocked'`
- Skip owner (D17)

### Fase 5 — Prerequisitos en API

- `orders_enabled=true` → 400 si falta menú, pago ofrecible o fulfillment.
- Codes estables p.ej. `ORDERS_REQUIRES_MENU` | `ORDERS_REQUIRES_PAYMENT` | `ORDERS_REQUIRES_FULFILLMENT`.
- `canOrder` en runtime también exige menú/fulfillment.

### Fase 6 — Opcional backend

- Script auditoría.
- Exigir mesas al activar reservas (si se decide después).

---

## 6. Orden de implementación

```
Fase 1 → Fase 2 → Fase 4 → Fase 3 → Fase 5
```

---

## 7. Riesgos

| Riesgo | Mitigación |
|--------|------------|
| e2e asumen pedidos on | Harness activa flags + menú + método + fulfillment |
| Online activo sin MP | D4 usa offered |
| `checkout_enabled` divergente | D16 sync |
| Panel muestra mal el estado | Plan admin; backend solo garantiza datos + 400 |

---

## 8. Plan de prueba (backend)

- [x] Create → flags limpios; 0 métodos ofrecidos.
- [x] Listar/seed pagos → inactivos; sin cobro.
- [x] 0 activos en métodos → OK.
- [x] `orders_enabled=true` sin menú / sin pago / sin fulfillment → 400 con code.
- [x] Setup completo → pedido OK. *(validación unitaria de prerequisitos + canOrder)*
- [x] Solo reservas → pedido rechazado; reserva OK. *(gate tools + reservations_only)*
- [x] Sin capacidades → earlyExit; no híbrido.
- [x] Activar método de pago **no** cambia `orders_enabled`. *(invariante: mutaciones payment no tocan config)*
- [x] Legacy sin regresión; owner assistant exento.

---

## 9. Criterio de éxito

1. Business nuevo sin capacidad implícita de pedido/reserva.
2. Seed de pagos no habilita cobro.
3. Bot no persigue objetivos imposibles.
4. Sin migración agresiva de existentes.
5. Cero alcance de UI admin en este plan.

---

## Referencias

- Create: `src/services/superAdminCreateBusiness.service.ts`
- Defaults: `src/services/businessConfig.service.ts`, `prisma/schema.prisma`
- Seed: `src/services/paymentMethods.service.ts`
- Reglas: `src/domain/payment/paymentMethodRules.ts`
- Gate billing: `src/graph/nodes/gates/index.ts`
- Gate reservas: `src/tools/reservation.ts`
- Handoff UI: [PLAN-ACCION-ADMIN-CAPABILITIES-SETUP.md](./PLAN-ACCION-ADMIN-CAPABILITIES-SETUP.md)
