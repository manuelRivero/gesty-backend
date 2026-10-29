# Plan de acción — Handoff bidireccional reserva↔menú + sugerencia por raciones

**Estado:** en desarrollo  
**Repos:** gesty-backend (espejo food-service-agent después)  
**Feature catálogo:** RES-05 (ver `docs/FEATURES.md`)

## Problema (evidencia)

Conversación 21/9/2026:

1. Cliente: *“Que platos sirven para las reservas?”*
2. Bot (híbrido): pide *“¿Para cuántas personas?”* (party size de **pedido**).
3. Cliente: *“Para 6”*
4. Bot: confirma seis personas “para la reserva” en prosa, pero **no abre sesión de reserva** ni arma `reservation_draft`; ofrece nombre de plato / menú completo (flujo de pedido).

**Lectura:** el híbrido interpretó “reservas” + “platos” como comida → Goal de party size de pedido (`save_party_size`), no como entrada a reservas (`start_reservation_session`). El dato de “6” **no queda** en el borrador de mesa; si después quieren reservar, empiezan de cero.

Ancla de diseño actual:

- Híbrido debe delegar reserva con `start_reservation_session` (personas/fecha/slot son del agente de reservas) — `botPersonality` § RESERVAS DE MESA.
- Mid-reserva, menú/precio/ración → `delegate_to_main` (FAQ) y vuelve con resume — no al revés para armar el draft.
- En **pedido**, está prohibido filtrar por `minServesPeople` (“para N” = comensales del pedido, no ración del plato).

## Decisión de producto

| Tema | Decisión |
|------|---------|
| “Especial para reservas” como flag/admin | **No.** Sin input nuevo en el formulario. |
| Criterio de platos “para la mesa” | **`serves_people` vs personas de la reserva** (borrador). |
| Quién pide / guarda “somos 6” en este frame | **Agente de reservas** → `reservation_draft.partySize`. |
| Quién lista platos por ración | **Híbrido** (catálogo), vía FAQ mid-reserva **después** de tener party size en el draft (o en el mismo turno post-`save_reservation_party_size` + `delegate_to_main`). |
| Work en curso `extra.reservations.available` | **Abandonar / revertir** — no aplica a este requerimiento. |

## Enfoque (orden de implementación)

### Fase 0 — Limpiar

- Revertir o no mergear WIP de `menuItemReservationPolicy` / `available`+`anticipationDays` en admin PATCH si quedó a medias.
- No persistir policy de “disponible para reserva”.

### Fase 1 — Handoff bidireccional correcto (antes de la tool nueva)

**1.A Main → Reservas (ampliar entrada)**

Ampliar cuándo el híbrido **debe** llamar `start_reservation_session` en este turno, no pedirle party size de pedido:

- Preguntas de menú **enmarcadas en reserva**: *“qué platos sirven para las reservas”*, *“para reservar sirven pollo?”*, *“algo especial para la mesa / para reservar”*.
- Prompt: si el mensaje ancla **reserva/mesa** + consulta de platos/raciones → `start_reservation_session(reason)`; **PROHIBIDO** `save_party_size` / Goal de pedido en ese turno.
- Tests de prompt/ruteo: el mensaje del log no debe abrir party size de pedido.

**1.B Reservas recibe el turno y avanza el draft**

- Al entrar por ese `reason`, el agente de reservas:
  1. Si falta `partySize` → preguntar / `save_reservation_party_size` (mismo camino tipable que hoy).
  2. Si el mensaje ya trae N (*“para 6”*, *“sirve pollo para 6 en reserva”*) → persistir N en el draft en ese turno.
  3. **No** abandonar el borrador al contestar menú: el draft es el valor; la duda de platos no es un FAQ suelto en el híbrido sin sesión.

**1.C Reservas → Main (FAQ de catálogo con contexto de mesa)**

- Con `partySize` en draft (o recién guardado), para listar/sugerir platos: `delegate_to_main` con reason claro (*sugerir platos para mesa de N*).
- Ledger FAQ mid-reserva ya inyecta *“Mesa en borrador: N personas”* — el híbrido usa **N de reserva**, no party size de pedido.
- Tras la respuesta, resume de reserva (seguir con fecha/slot/ambiente) como hoy.
- Prompt FAQ: en este modo **sí** filtrar/sugerir por `serves_people` ≈ N; sigue **prohibido** armar pedido / `save_party_size` de pedido.

**1.D Main → Reservas (ya en sesión)**

- Si llega otro mensaje de menú mid-reserva y la sesión ya está activa: híbrido no reabre; o el turno ni llega al híbrido (lo toma reservas y vuelve a `delegate_to_main`). Mantener `reservation_session_already_active` / FAQ como está.

**Criterio de hecho Fase 1**

- *“Qué platos sirven para las reservas?”* → abre reservas (o sigue en reservas), pide personas de **mesa**, el “6” queda en `reservation_draft`.
- Después de responder platos, el próximo paso sigue siendo completar la reserva (fecha/horario/…), no “¿qué plato querés pedir?”.

### Fase 2 — Tool de sugerencia por raciones (híbrido)

- Tool nueva en el **híbrido** (ej. `suggest_dishes_for_party_size` / nombre final a definir):
  - Input: `partySize` (obligatorio) o leer N del ledger de mesa en FAQ.
  - Output: shortlist ranqueada **en la tool** (sin LLM): `exact` → `near` (N..N+2) →
    `cover` (`suggestedUnits = ceil(N/serves)`) → `over` solo si no hay nada que cubra.
    Decidido en Fase 9 de `PLAN-ACCION-ESTADO-DOMINIO-TURNO-FRIO.md`.
  - No usa tags ni `extra.reservations`.
- Prompt:
  - FAQ mid-reserva / reason de sugerencia mesa: usar esta tool (o documentar excepción clara si se reutiliza `find_products_by_filter(minServesPeople)` **solo** en FAQ reserva).
  - Pedido normal: **sigue** la regla actual — no filtrar por `minServesPeople` por “comida para N”.
- Tests de tool + un caso de integración FAQ mid-reserva con draft `partySize: 6`.

### Fase 3 — Espejo y admin

- Espejo en food-service-agent.
- **Sin** cambio de formulario admin (solo se usa `serves_people` ya existente).
- Brief opcional `CONTEXTO-ADMIN-…` solo si hace falta documentar que “especial” = ración bien cargada, no un nuevo checkbox.

## Flujos objetivo (resumen)

```text
Cliente: "qué platos sirven para las reservas?"
  → híbrido: start_reservation_session
  → reservas: pide personas de mesa (si faltan)
Cliente: "para 6"
  → reservas: save_reservation_party_size(6)  // draft
  → reservas: delegate_to_main(sugerir para 6)
  → híbrido FAQ: tool por raciones + serves_people
  → resume: seguimos con la reserva (fecha/…)

Cliente: "para las reservas sirven pollo?"
  → híbrido: start_reservation_session (o FAQ si ya hay sesión)
  → reservas: party size si falta → delegate → search/detalle pollo + serves_people vs N
```

## Fuera de alcance

- Flag “especial para reservas” / anticipación / `available`.
- Poner tools de catálogo dentro del agente de reservas (salvo que Fase 1 demuestre que el bounce FAQ es inaceptable en latencia; hoy preferimos un solo dueño de catálogo = híbrido).
- Cambiar el significado de party size de **pedido**.

## Riesgos

| Riesgo | Mitigación |
|--------|------------|
| Híbrido sigue pidiendo party size de pedido ante “reservas” | Tests + prompt estricto; gate: si el mensaje matchea entrada reserva, no abrir Goal pedido. |
| “Para 6” ambiguo (pedido vs mesa) | Si `reservation_agent_active` o acabamos de abrir por reason menú-reserva → mesa; si solo pedido → pedido. |
| Sugerir platos sin N | Reservas pregunta N antes de `delegate_to_main` de sugerencia. |
| Tool nueva vs `minServesPeople` existente | Preferir tool dedicada o instrucción FAQ muy acotada para no romper la regla de pedido. |

## Checklist

- [x] Revertir WIP `extra.reservations.available` si aplica
- [x] Prompt + tests: entrada menú-en-reserva → `start_reservation_session`
- [x] Reservas: party size al draft primero; luego FAQ menú con N de mesa
- [x] Tool híbrido `suggest_dishes_for_party_size` + prompt FAQ
- [x] Sin sesión de reserva: la tool devuelve `reservation_session_required` (no gate de pedido). Evidencia: log 21/9 repetía “¿Para cuántas personas?” en loop porque el gate corría antes del argumento `partySize` y el prompt prohíbe `save_party_size` en marco reserva.
- [ ] E2E o harness: conversación del log 21/9 (manual / follow-up)
- [x] `docs/FEATURES.md` RES-05 → en desarrollo
- [x] Espejo food-service-agent

## Referencias de código

- Híbrido RESERVAS: `src/prompts/botPersonality.ts` (RESERVAS DE MESA, FAQ mid-reserva, PORCIONES vs PEDIDO)
- Entrada: `start_reservation_session` en `src/tools/reservation.ts`
- FAQ: `reservationFaqDelegation.service`, `delegate_to_main` en `src/graph/nodes/reservation/index.ts`
- Party size pedido: `partySizeGoal.service.ts` — cerrado vía `blocksOrderPartySizeForReservationDomain` (FAQ / agent active / pending switch; **no** draft solo ni diccionario de prosa)
