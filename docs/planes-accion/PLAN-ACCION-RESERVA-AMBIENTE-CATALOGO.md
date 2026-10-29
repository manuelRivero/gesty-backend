# Plan de acción — Ambiente en prosa fuera de catálogo

| | |
|--|--|
| **EJECUTAR EN** | `gesty-backend` (este repo) |
| **Estado** | Hecho — 2026-09-16 (gate `invalid_environment` + hints + prompt + units + e2e suite) |
| **Fecha** | 2026-09-16 |
| **Caso** | Producción Picado · caso 3 (“carpa cerca de los juegos”) |
| **Objetivo** | Si el cliente nombra un ambiente **que no está** en el catálogo, el bot **aclara**, re-ofrece ambientes (o “sin preferencia”) y **no inventa** un `environmentId`. Si coincide con el catálogo, persiste el id. |

---

## 1. Por qué

En producción el local ofrece sectores (p. ej. salón / carpa). El agente a veces:

- Persiste un ambiente sin validar contra catálogo.
- Ante un nombre desconocido, cambia de tema (re-lista horarios) en vez de aclarar.

El prompt ya pide aclarar; hace falta **gate en tool** + hints tipables + verificación.

---

## 2. Comportamiento objetivo

1. Match de catálogo (exacto o parcial inequívoco) → `save_reservation_environment(id)`.
2. Fuera de catálogo → aclarar + `get_available_environments` / sin preferencia; no inventar id; no saltar a slots.
3. “Me da igual” → `null`.
4. Sin regex pre-ReAct.

---

## 3. Invariantes

| # | Invariante |
|---|------------|
| I1 | Solo ids de catálogo o `null` en el draft |
| I2 | Fuera de catálogo → error / tipable no-fulfilled + aclaración |
| I3 | No inventar; no cambiar a slots |
| I4 | Sin `tryHandle*` / regex |

---

## 4. Piezas (gesty-backend)

| Pieza | Path |
|-------|------|
| Gate tool | `src/tools/reservation.ts` → `save_reservation_environment` |
| Hints tipable | `src/agents/reservationAgent.ts` → `buildSelectEnvironmentValueHints` |
| Prompt | `src/prompts/botPersonality.ts` |
| Units | `reservation.test.ts`, `selectSlotValueHints.test.ts`, `botPersonality.test.ts` |

---

## 5. Fases

### Fase 1

- [x] Gate `invalid_environment`
- [x] Hints + prompt (ejemplo carpa)
- [x] Units

### Fase 2 — Fuera de alcance

- Alta de ambientes reales en el negocio
- Max party size; menú mid-reserva; banda horaria

### Fase 3

- [x] Units verdes (`ambiente-desconocido` en `test:reservation-production`)

---

## 6. Criterios de aceptación

| # | Aceptación | Estado |
|---|------------|--------|
| A1 | Nombre desconocido → sin `environmentId` inventado | Gate |
| A2 | Aclara / ofrece catálogo; no solo re-pide horario | Prompt + hints |
| A3 | Tool rechaza uuid inválido | Unit |
| A4 | Match de catálogo sigue OK | Unit |

---

## 7. Checklist al cerrar

- [x] Fix en gesty-backend
- [x] Units OK
- [x] Sin regex pre-ReAct
- [x] Estado → Hecho (2026-09-16)
