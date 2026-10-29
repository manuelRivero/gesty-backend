# Plan de acción — FAQ de menú mid-reserva (foco híbrido + Goals)

| | |
|--|--|
| **EJECUTAR EN** | `gesty-backend` (este repo) |
| **Estado** | Hecho — 2026-09-16 (Fact D1 + Goals D2 + ledger/prompt + resume D3 + units; endurecido: FAQ sin ofrecer pedido en prosa) |
| **Fecha** | 2026-09-16 |
| **Caso** | Producción Picado · menú mid-reserva (calidad de respuesta) |
| **Objetivo de producto** | Reserva en curso → pregunta de menú → híbrido **responde la duda** (catálogo) → ofrece **seguir con la reserva** o **cancelarla**. No pivotear a “armar pedido”. |

---

## 1. Por qué

Tras `delegate_to_main` desde reservas, el híbrido a menudo:

- Responde como si hubiera que **armar un pedido** (reusa “somos N” del historial).
- No usa (o casi no) tools de menú.
- Puede narrar errores internos (“sesión de reserva activa”).

Causa raíz típica:

| Hecho | Ancla |
|-------|--------|
| `COMPLETAR_RESERVA` ya cerrado con `reservationAgentActive` | `deriveReservationCompletionGoal` |
| Ledger del híbrido sin “turno FAQ mid-reserva” | `buildContextMessage` |
| Prompt: “para N personas” = armar pedido | `buildHybridAgentSystemPrompt` |
| `OBTENER_PERSONAS_DEL_PEDIDO` puede abrirse en queries de menú sin mirar reserva activa | `partySizeGoal.service.ts` |

Suprimir solo el Goal de reserva **no alcanza**. Hace falta Fact de delegación + condicionar Goals de pedido + prompt anclado.

---

## 2. Comportamiento objetivo (UX)

1. Reserva activa + draft.
2. FAQ menú/precio/ración → `delegate_to_main`.
3. Híbrido: responde con catálogo; no arma pedido; no filtra errores de tool.
4. Cierre: **seguir** reserva (paso pendiente) o **cancelar** (próximo turno / abandon).

---

## 3. Invariantes

| # | Invariante |
|---|------------|
| I1 | Fact efímero de delegación FAQ set/clear en el mismo turno `delegate_to_main` |
| I2 | No `OBTENER_PERSONAS_DEL_PEDIDO` / no empujón `COMPLETAR_PEDIDO` / Opportunities de pedido bajo ese modo |
| I3 | Ledger declara modo FAQ + personas del **draft** (mesa), no del pedido |
| I4 | Prompt híbrido anclado al Fact |
| I5 | Resume de reserva post-respuesta |
| I6 | Sin regex / `tryHandle*` pre-ReAct |
| I7 | Handback solo para “quiero pedir / navegar menú”, no FAQ puntual |

### Decisiones

**D1 — Fact `reservation_faq_delegation`** (`reason?`, `delegatedAt`): set antes del hybrid, clear al salir de la rama.

**D2 — Condicionar Goals de pedido** (party-size blocking, opportunities/oferta, hint completar pedido) si Fact o `reservation_agent_active`. No re-suprimir `COMPLETAR_RESERVA` (ya off).

**D3 — Resume determinístico** post-FAQ: **solo** “¿Seguimos con la reserva o preferís cancelarla?”.
  No anexar fecha/horario (eso lo pide el agente de reservas en el turno siguiente, slots en lista).
  Ajuste 21/9: `PLAN-ACCION-ESTADO-DOMINIO-TURNO-FRIO.md` Fase 10.

**D4 — Cancelar** vía reservation agent (`abandon_reservation`) en turno siguiente / tipable; no abrir carrito.

---

## 4. Piezas (gesty-backend)

| Pieza | Path |
|-------|------|
| Fact service | `src/services/reservationFaqDelegation.service.ts` |
| Metadata types | `src/services/productQuery/types.ts` |
| Nodo reservas | `src/graph/nodes/reservation/index.ts` |
| Context / ledger | `src/agents/contextMessage.ts` |
| Party size | `src/services/partySizeGoal.service.ts` |
| Prompt híbrido | `src/prompts/botPersonality.ts` |
| Resume | `src/graph/nodes/session/buildResumeFollowUp.ts` |
| E2E | `e2e/reservation-production.e2e.test.ts` · `menu-durante-reserva` |

---

## 5. Fases

### Fase A — Fact delegación

- [x] Tipar + set/clear en `delegate_to_main`
- [x] Unit service + contextMessage

### Fase B — Goals

- [x] Party size goal gated
- [x] No surface pedido/opportunities bajo Fact
- [x] Unit partySize / context

### Fase C — Ledger + prompt

- [x] Líneas FAQ mid-reserva + mesa del draft
- [x] Prompt híbrido
- [x] Unit prompt

### Fase D — UX seguir / cancelar

- [x] Resume / sufijo determinístico (`RESERVATION_FAQ_CONTINUE_OR_CANCEL`)

### Fase E — E2E

- [x] Asserts endurecidos en `menu-durante-reserva` (no armar pedido + resume)
- [ ] Guardar evidencia literal de corrida real (`npm run test:reservation-production`) cuando haya entorno

### Fuera de alcance

- Tools de menú en reservation agent
- Handback por defecto para FAQ
- Max party size / botones WA nuevos (salvo decisión explícita)

---

## 6. Criterios de aceptación

| # | Aceptación | Estado |
|---|------------|--------|
| A1 | FAQ → respuesta de menú (catálogo) | Prompt + anti-loop previo |
| A2 | Sin pivot a armar pedido | Goals + prompt + e2e soft |
| A3 | Draft + sesión intactos | Machinery previa |
| A4 | Oferta seguir reserva o cancelar | Resume D3 |
| A5 | E2E + evidencia | Asserts listos; corrida live pendiente de env |

---

## 7. Checklist al cerrar

- [x] Fix en gesty-backend
- [x] Units verdes
- [x] Sin regex pre-ReAct
- [x] Estado → Hecho (2026-09-16)
- [ ] Evidencia literal post-corrida e2e (ops)
