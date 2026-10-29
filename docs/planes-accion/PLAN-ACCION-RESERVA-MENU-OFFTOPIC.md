# Plan de acción — Menú / precios off-topic durante reserva

| | |
|--|--|
| **EJECUTAR EN** | `gesty-backend` (este repo) |
| **Estado** | Hecho — 2026-09-16 (prompt estricto + anti-loop + units + suite e2e portada) |
| **Fecha** | 2026-09-16 |
| **Caso** | Producción Picado · caso 1 (menú mid-reserva) |
| **Objetivo** | Si el cliente pregunta por platos / raciones / precios **durante** una sesión de reserva, el bot **responde el dato de menú** (vía híbrido) **sin perder** `reservation_draft` ni abandonar el flujo. |

---

## 1. Por qué

Conversación real (humano hoy) — el cliente intercala reserva + menú:

> «Y te consulto algo que me preguntan, si el matambre a la pizza comerán 3 .. o la parrillada. O es por plato el precio»

El humano responde la ración (comparten 2–3) y sigue la reserva.

Síntomas observados con el agente:

| Observación | Qué pasa |
|-------------|----------|
| A veces **ignora** la pregunta de menú y avanza Facts de reserva (fecha/party) | Copy de horarios; cero respuesta de raciones |
| A veces **simula** handback en prosa sin tool | *«te dejo con el asistente principal…»* pero `reservation_agent_active` sigue `true` |
| El draft **suele** conservarse | El bug es de **respuesta al cliente**, no de borrado de draft |

La maquinaria ya existe: `delegate_to_main` → híbrido inline + `buildResumeFollowUp`. El fallo es que el LLM del reservation agent no llama la tool (o inventa copy de transición).

---

## 2. Comportamiento objetivo

1. Mensaje de **menú / precios / raciones / ingredientes** con `reservation_agent_active`:
   - Llamar **`delegate_to_main(reason)`** (no inventar “te paso al asistente”).
   - El híbrido responde con tools de menú.
   - El nodo anexa el resume del paso pendiente (ya implementado).
2. Sesión y draft intactos tras delegate.
3. **`handback_reservation`** solo si el cliente quiere **navegar/pedir** en serio.
4. **Prohibido:** regex / `tryHandle*` pre-ReAct sobre prosa del usuario.

---

## 3. Invariantes

| # | Invariante |
|---|------------|
| I1 | Off-topic puntual (menú, precio, ración) → `delegate_to_main`, sesión viva |
| I2 | Off-topic de acción (armar pedido / ver menú para elegir) → `handback_reservation` |
| I3 | Nunca redactar “te paso / te dejo con el asistente” sin tool |
| I4 | Tras delegate: respuesta de menú + resume de reserva si falta un Fact |
| I5 | No priorizar `save_reservation_*` si la intención dominante del mensaje es menú/precio |
| I6 | Sin matchers determinísticos pre-ReAct |

---

## 4. Piezas (gesty-backend)

| Pieza | Path |
|-------|------|
| Prompt reservas | `src/prompts/botPersonality.ts` → `buildReservationAgentSystemPrompt` |
| Prompt híbrido | mismo archivo — `reservation_session_already_active` |
| Tools | `src/tools/reservation.ts` — gate anti-loop en `start_reservation_session` |
| Nodo delegate + resume | `src/graph/nodes/reservation/index.ts` (ya cableado) |
| Units | `botPersonality.test.ts`, `reservation.test.ts` |

---

## 5. Fases

### Fase 0 — Baseline e2e

- [x] Suite `npm run test:reservation-production` portada (`e2e/reservation-production.e2e.test.ts`)
- [x] Caso `menu-durante-reserva` incluido

### Fase 1 — Endurecer prompt (fix principal)

- [x] Alinear con checkout: no redactar transición; menú/precio/ración → `delegate_to_main` **antes** que `save_reservation_*` / slots
- [x] Ejemplo explícito estilo Picado (raciones mid-reserva)
- [x] Clarificar delegate vs handback
- [x] Unit de prompt

### Fase 1b — Anti-loop híbrido

- [x] Gate en `start_reservation_session`: si `reservation_agent_active`, error `reservation_session_already_active`
- [x] Prompt híbrido: ante ese error, responder menú/precios (no re-delegar)
- [x] Unit del gate

### Fase 3 — Fuera de alcance

- Tools de menú en el reservation agent
- Regex pre-ReAct
- Casos slot “a la noche” / ambiente / max party size

### Fase 4 — Verificación

- [x] Units prompt + gate verdes
- [x] Suite e2e portada (`test:reservation-production`)
- [ ] Smoke WA opcional con frase Picado

---

## 6. Criterios de aceptación

| # | Aceptación | Estado |
|---|------------|--------|
| A1 | Pregunta de ración/precio mid-reserva obtiene respuesta útil de menú (vía híbrido) | Prompt + anti-loop |
| A2 | Draft + `reservation_agent_active` intactos tras delegate | Machinery previa + gate |
| A3 | Sin copy de “te dejo con el asistente” sin tool | Prompt |
| A4 | Resume del paso pendiente de reserva tras la respuesta de menú | Machinery previa |
| A5 | Suite e2e producción | `npm run test:reservation-production` |

---

## 7. Checklist al cerrar

- [x] Fix en **gesty-backend**
- [x] Units verdes
- [x] Sin regex pre-ReAct nuevo
- [x] Estado → Hecho (2026-09-16)
