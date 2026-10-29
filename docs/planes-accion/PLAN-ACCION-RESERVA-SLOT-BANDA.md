# Plan de acción — Banda horaria en prosa → slot (`a la noche`)

| | |
|--|--|
| **EJECUTAR EN** | `gesty-backend` (este repo) |
| **Estado** | Hecho — 2026-09-16 (prompt + hints tipable + units + e2e `noche-a-slot`) |
| **Fecha** | 2026-09-16 |
| **Caso** | Producción Picado · caso 2 (sábado a la noche) |
| **Objetivo** | Si el cliente dice **mediodía / tarde / noche** (o “sábado a la noche”) con slots del día en catálogo, el agente **persiste un `slotId`** de esa banda y avanza; no se queda solo re-listando horarios. |

---

## 1. Por qué

Humano (Picado): el cliente elige “Sábado a la noche” y confirman un horario concreto de noche.

Con el agente suele pasar:

| Observación | Qué pasa |
|-------------|----------|
| A veces **solo re-lista** slots | “a la noche” → otra lista; `draft.slotId` ausente |
| A veces **sí** elige | “a la noche” → `slotId` + hora nocturna |
| Prompt típico | Enseña “a las 19:00”; no enseña **bandas** (noche/mediodía) |

Tipable `select_slot` + ReAct ya existen; falta mapeo banda → catálogo.

---

## 2. Comportamiento objetivo

1. Paso `slot` + “a la noche” / “mediodía” / “a la tarde” / “sábado a la noche”:
   - Elegir un slot del catálogo en esa banda → `save_reservation_slot` / tipable fulfilled.
2. Varios en la banda: uno razonable (p. ej. primer ≥ 19:00 para noche) y confirmar en prosa.
3. Ninguno en la banda: aclarar + `get_available_slots` (no inventar).
4. Sin regex pre-ReAct; hints al clasificador + prompt ReAct.

### Bandas

| Banda | `startTime` |
|-------|-------------|
| Mediodía | 11:00–15:59 |
| Tarde | 16:00–18:59 |
| Noche | 19:00–23:59 |

---

## 3. Invariantes

| # | Invariante |
|---|------------|
| I1 | Banda con catálogo → `draft.slotId` (o aclaración si no hay) |
| I2 | Solo ids de catálogo |
| I3 | Sin `tryHandle*` / regex de frases |
| I4 | Tras slot → siguiente Fact (`party_size`, etc.) |

---

## 4. Piezas (gesty-backend)

| Pieza | Path |
|-------|------|
| Prompt reservas | `src/prompts/botPersonality.ts` |
| Hints tipable | `src/agents/reservationAgent.ts` → `buildSelectSlotValueHints` |
| Nodo | `src/graph/nodes/reservation/index.ts` |
| Units | `botPersonality.test.ts`, `selectSlotValueHints.test.ts`, `reservationAgentNode.test.ts` |

---

## 5. Fases

### Fase 1 — Hints + prompt

- [x] `buildSelectSlotValueHints` con ejemplos de banda
- [x] Prompt paso HORARIO con bandas
- [x] Units (caso `noche-a-slot` en `test:reservation-production`)

### Fase 2 — Fuera de alcance

- Ambiente desconocido, max party size, menú mid-reserva

### Fase 3 — Verificación

- [x] Units del caso

---

## 6. Criterios de aceptación

| # | Aceptación | Estado |
|---|------------|--------|
| A1 | “a la noche” → `slotId` seteado si hay slots ≥ 19:00 | Hints + tipable nodo |
| A2 | `time` en banda noche | Catálogo / tipable |
| A3 | Sin inventar fuera de catálogo | Gate `invalid_slot` + prompt |
| A4 | E2E producción | `noche-a-slot` en `test:reservation-production` |

---

## 7. Checklist al cerrar

- [x] Fix en gesty-backend
- [x] Units OK
- [x] Sin regex pre-ReAct
- [x] Estado → Hecho (2026-09-16)
