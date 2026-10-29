# Contexto técnico — fixes de pruebas conversacionales (replicar en fork)

> **Paquete en gesty-backend (leer en este orden):**
> 1. Este archivo — qué portar y cómo (§3.11, archivos, tests).
> 2. `docs/arquitectura/PENDING-TIPABLES-AUTONOMIA.md` — norma de tipables (tabla actualizada con slot/party_size/claridad).
> 3. `agent-factory/agent-factory.md` §3.11 — ley tipable fulfilled en el nodo.
> 4. `.cursor/rules/hybrid-pending-autonomy.mdc` — prohibido regex/`tryHandle*` pre-ReAct.
> 5. `.cursor/rules/evidencia-antes-de-parche.mdc` — evidencia antes de parche en síntomas conversacionales.
> 6. `docs/ops/RESULTADO-AJUSTES-PRUEBAS-CONVERSACION.md` — aceptación UX (no técnica).
>
> Origen del lote: fork `food-service-agent` (pruebas WhatsApp Picado Fino). Issues portables: **#3 slot**, **#4 party size**, **#2 claridad fuera de shortlist** (+ clarity reservas/variación/pago). No portar #1/#5a/#5b como defectos de este lote.

Guía para **otro agente de código** que deba portar estos cambios a un fork del repo.  
Documento hermano (UX / no técnico): `docs/ops/RESULTADO-AJUSTES-PRUEBAS-CONVERSACION.md`.

Normas del repo que rigen estos fixes:

- `.cursor/rules/evidencia-antes-de-parche.mdc` — síntoma conversacional → evidencia antes de diff.
- `.cursor/rules/hybrid-pending-autonomy.mdc` — tipables: gate en tools + ledger + ReAct; **prohibido** `tryHandle*Hybrid` / regex pre-ReAct.
- `agent-factory/agent-factory.md` §3.11 — tipable fulfilled en el **nodo** = mismo efecto que el botón, **antes** del ReAct.
- `docs/arquitectura/PENDING-TIPABLES-AUTONOMIA.md` — tabla normativa de pendings.

---

## Resumen de issues

| ID | Síntoma | ¿Fix? | Tipo de solución |
|----|---------|-------|------------------|
| **#3** | Reserva: “Sí a las 19:00” → re-lista horarios | Sí | Tipable §3.11 `select_slot` + tool `save_reservation_slot` |
| **#4** | Reserva: tipá “4” → re-pregunta personas | Sí | Tipable §3.11 `party_size` + capacidad compartida |
| **#2** | Shortlist (ej. empanadas) + “y de mozzarella” → salta de categoría en silencio | Sí | Prompt + ledger: **FUERA DEL SHORTLIST** (claridad antes de buscar) |
| Clarity extra | Horario/ambiente fuera de catálogo; variación inválida; pago no ofrecido | Sí | Mismo criterio de claridad en prompts/ledger |
| **#1** | “Parrilla” → complementos prematuros | **No** en este lote | Pendiente |
| **#5a** | “Compartir… para 3 personas” sin decir 3 | **No** (no defect) | Metadata sucia / alucinación; reiniciar pedido |
| **#5b** | “Parrillada Clásica” sin info | **No** (no defect) | Ficha vacía o no hidrató `get_products_details_by_ids` |

---

## Patrón canónico (reservas §3.11)

Referencia ya existente en el árbol: tipables de **ambiente** y **confirmación**. Slot y party size se alinearon a ese patrón.

```
mensaje tipable (paso = slot | party_size | environment | confirm)
  → nodo: extractPendingTurnResponse(...)
  → si status === 'fulfilled' (+ validación de catálogo/capacidad)
      → mismo efecto que botón/tool (patchReservationDraft / confirm / cancel)
      → si draft listo para confirm → tarjeta; si no → ReAct con skipPendingExtraction
  → si no fulfilled → ReAct (+ bloque [EXTRACCIÓN PASO PENDIENTE] en ledger)
```

**PROHIBIDO al portar:**

- Regex / diccionarios / `tryHandle*Reservation*` que intercepten “4” o “a las 19” antes del clasificador.
- Solo inyectar el bloque al prompt y esperar que el ReAct llame la tool (asimetría botón vs prosa = bug §3.11).
- Inventar `slotId` / ambiente fuera del catálogo del draft.

Contraste de pasos:

| Paso | Tipable en nodo | Write |
|------|-----------------|-------|
| `slot` | `extractSelectSlotPending` | `patchReservationDraft({ slotId, time, endTime })` o `save_reservation_slot` |
| `party_size` | `extractPartySizePending` | `patchReservationDraft({ partySize })` o `save_reservation_party_size` |
| `environment` | `extractSelectEnvironmentPending` | ya existía |
| `confirm` | `extractConfirmReservationPending` | ya existía |
| `date` | (sigue solo ReAct) | `save_reservation_date` |

---

## Fix #3 — Horario tipable (`select_slot`)

### Causa raíz
Con `Paso actual: slot`, solo el payload `RESERVATION_SLOT:{id}` persistía el horario. Prosa caía al ReAct; el ledger pedía `get_available_slots` → re-lista.

### Qué implementar

1. **Extractor** en `src/agents/reservationAgent.ts`
   - Schema `{ slotId: string }`
   - `buildSelectSlotValueHints(slots)` con catálogo id ↔ `startTime`–`endTime`
   - `extractSelectSlotPending(userMessage, slots)`
   - `isValidSlotSelection(slotId, slots)`

2. **Contexto del agente** `ReservationAgentContext.availableSlots`
   - Nodo carga slots del día vía `fetchReservationSlotsForBusinessDate(businessId, normalizeDate(draft.date))`
   - Ledger: línea `Horarios disponibles: …` + regla fuera de catálogo
   - Inyectar `[EXTRACCIÓN PASO PENDIENTE]` cuando `step === 'slot'`

3. **Nodo** `src/graph/nodes/reservation/index.ts`
   - Antes del ReAct: si `tipableStep === 'slot'` y hay catálogo → extract → fulfilled → `patchReservationDraft` (usar **return value** del patch, no re-leer mockable stale)
   - Si `nextReservationStep` === `confirm` → `buildConfirmationButtonsMessage`
   - Si falta party/ambiente → `skipPendingExtraction = true` y seguir al ReAct

4. **Tool** `save_reservation_slot` en `src/tools/reservation.ts`
   - Gate: `fetchActiveReservationSlotById` → `invalid_slot` o merge draft
   - Agregar a `allReservationTools`

5. **Prompt** `buildReservationAgentSystemPrompt` — sección HORARIO: prosa OK + `save_reservation_slot`; fuera de catálogo → aclarar + re-mostrar lista

6. **`expectedActionForReservationStep('slot')`** — mencionar tipable / save_reservation_slot

### Tests
`src/graph/nodes/reservation/__tests__/reservationAgentNode.test.ts`  
`src/tools/__tests__/reservation.test.ts` (gate `invalid_slot`)

Mockear `extractSelectSlotPending`, `isValidSlotSelection`, `fetchReservationSlotsForBusinessDate`.

---

## Fix #4 — Party size tipable (`party_size`)

### Causa raíz
Misma asimetría que #3: solo ReAct → `save_reservation_party_size`. Si el modelo re-preguntaba, loop.

### Qué implementar

1. **Extractor** en `reservationAgent.ts`
   - Schema `{ count: number }` (int positive)
   - `extractPartySizePending(userMessage, maxCapacity?)`
   - `isValidPartySizeSelection(count, maxCapacity)` — `maxCapacity <= 0` = sin tope

2. **Capacidad compartida** `src/services/reservations/capacity.ts`
   - `getMaxCombinablePartySize(businessId)` = suma de `findActiveTablesByBusinessAndEnvironment`
   - Usada por la tool y por el nodo (no importar tools desde el nodo)

3. **Nodo**
   - Cargar `reservationCtx.maxPartySize`
   - Rama `tipableStep === 'party_size'`: extract → si count > max → mensaje con máximo **sin** persistir; si válido → patch → confirm o ReAct con `skipPendingExtraction`

4. **Ledger** — extract cuando `step === 'party_size'`

5. **`expectedActionForReservationStep('party_size')`** + prompt PERSONAS

### Tests
Casos: fulfilled → confirm; fulfilled over capacity → no patch; fulfilled + ambientes → ReAct con skip.

---

## Fix #2 — Claridad “fuera del shortlist” (híbrido)

### Causa raíz
Tras complemento / `SELECT_FROM_LIST`, el ledger tenía candidatos; la excepción “otro plato” + “NOMBRA un plato → foco global” permitían `search_products` / `present_category` **sin** explicar el cambio de foco.

### Qué implementar (solo prompt + ledger; **sin** matcher pre-ReAct)

1. **`src/prompts/botPersonality.ts`** (hybrid)
   - Bala **FUERA DEL SHORTLIST**: en ese turno NO `search_products` / `find_products_by_filter` / `present_category` / nuevo CTA; aclarar + preguntar OK; solo buscar fuera tras aceptación.
   - Ajustar “NOMBRA un plato”: con shortlist pendiente sin match → FUERA DEL SHORTLIST (no foco global silencioso).
   - VARIACIONES: variedad fuera de catálogo → aclarar opciones del plato, no buscar otro SKU.
   - Checkout pago: `payment_method_not_offered` → una frase de claridad + `present_payment_options`.

2. **`src/agents/contextMessage.ts`** — `buildPendingProductSelectionLines`
   - Línea “Fuera del shortlist… Solo con OK explícito buscá fuera.”

3. **`src/services/pendingVariation.service.ts`** — misma claridad en ledger de variación.

4. **Reservas** (mismo criterio de opacidad): fuera de catálogo slot/ambiente en prompt + líneas del ledger en `reservationAgent.ts`.

### Tests
- `src/prompts/__tests__/botPersonality.test.ts` → `/FUERA DEL SHORTLIST/`
- `src/agents/__tests__/contextMessage.test.ts` → “Fuera del shortlist”
- `src/services/__tests__/pendingVariation.service.test.ts`

---

## Archivos tocados (checklist de port)

```
src/agents/reservationAgent.ts          # extractors slot + party_size; ledger; context fields
src/graph/nodes/reservation/index.ts    # short-circuit tipables; load slots + maxPartySize
src/tools/reservation.ts                # save_reservation_slot; usa capacity.ts
src/services/reservations/capacity.ts   # NUEVO — getMaxCombinablePartySize
src/services/reservations/nextReservationStep.ts  # expectedAction slot/party_size
src/prompts/botPersonality.ts           # hybrid FUERA DEL SHORTLIST; reservas; checkout; variaciones
src/agents/contextMessage.ts            # ledger shortlist
src/services/pendingVariation.service.ts
docs/arquitectura/PENDING-TIPABLES-AUTONOMIA.md
docs/ops/RESULTADO-AJUSTES-PRUEBAS-CONVERSACION.md  # UX
+ tests listados arriba
```

### Comando de verificación

```bash
npx vitest run \
  src/graph/nodes/reservation/__tests__/reservationAgentNode.test.ts \
  src/tools/__tests__/reservation.test.ts \
  src/services/reservations/__tests__/nextReservationStep.test.ts \
  src/prompts/__tests__/botPersonality.test.ts \
  src/agents/__tests__/contextMessage.test.ts \
  src/services/__tests__/pendingVariation.service.test.ts
```

---

## Orden sugerido al replicar en un fork

1. Confirmar que el fork ya tiene tipables de **ambiente + confirm** en reservas (§3.11). Si no, portar esos primero (son el molde).
2. Portar **#3** (slot) + tests.
3. Portar **#4** (party size + `capacity.ts`) + tests.
4. Portar **#2** (prompt/ledger claridad shortlist + variaciones + pago + fuera de catálogo reservas).
5. Actualizar `PENDING-TIPABLES-AUTONOMIA.md`.
6. No “arreglar” #5a/#5b con regex ni inventar party size; #1 queda fuera de este lote.

---

## Criterios de aceptación (agente)

- [ ] Prosa de horario ofrecido persiste `slotId` **sin** depender del ReAct.
- [ ] Prosa de cantidad válida persiste `partySize` **sin** depender del ReAct.
- [ ] Over-capacity de personas: mensaje con máximo, sin write.
- [ ] Shortlist activo + tipable fuera de candidatos: **no** nueva lista/categoría en el mismo turno sin OK del cliente.
- [ ] Cero `tryHandle*` / regex de frases de usuario para estos tipables.
- [ ] Tests del nodo tipable + gates de tools en verde.
