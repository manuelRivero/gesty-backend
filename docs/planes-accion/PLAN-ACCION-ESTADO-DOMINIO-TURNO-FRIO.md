# Plan de acción — Estado de dominio en turno frío (mapa de sesiones + capacidades)

**Estado:** en desarrollo (gesty-backend validado; espejo food-service-agent fases 1–14: runtime + tests)
**Repos:** gesty-backend (espejo food-service-agent después)
**Feature catálogo:** BOT-07 (ver `docs/FEATURES.md`)

## Problema (evidencia)

Conversación 21/9/2026, mensaje *“Que platos sirven para la reserva ?”* en turno frío
(sin carrito, sin sesión, sin `welcomeEligible`). El bloque que recibió el agente fue,
completo:

```
[ESTADO DEL CLIENTE]
- Personas para el pedido: no informado — si hay Goal OBTENER_PERSONAS_DEL_PEDIDO abajo o una tool devuelve party_size_required, preguntá PRIMERO y recién después shortlist/add

Que platos sirven para la reserva ?
```

El armado de `lines` en `contextMessage.ts` es casi todo condicional a Facts de pedido /
sesión; sin ninguno, sobrevive **solo** la línea de personas del pedido, que además trae un
imperativo (“preguntá PRIMERO”). El bloque no arranca en blanco: arranca **inclinado a pedido**.

Resultado observado: el bot respondió *“¿Para cuántas personas?”* (`sentiment=FRUSTRATED`),
y en el turno siguiente llamó `save_party_size` — el Fact de personas del **pedido** — en una
conversación que era de reserva.

### Lo que NO es la causa

- **Capacidades ausentes:** `reservationDelegationEnabled` estaba en `true`; la sección
  `RESERVAS DE MESA` del system prompt sí estaba, y por eso el turno 2 pudo delegar.
- **Prompt flojo:** el bullet de “platos enmarcados en reserva → `start_reservation_session`”
  ya existe con cuatro ejemplos (ver `botPersonality` § RESERVAS DE MESA).

La asimetría real: los **botones** del welcome ya son capability-aware
(`smallTalk.service.ts` muestra “Reservar mesa” solo si `capability.hasReservations`),
pero el **estado por turno** del ReAct no sabe nada de eso ni de qué sesiones hay abiertas.

## Decisión de producto

| Tema | Decisión |
|------|---------|
| Modelarlo como Goal (`DESAMBIGUAR_DOMINIO`) | **No.** Un Goal pregunta, tiene ledger y presión, y compite con party size. Esto es **estado declarado**, no un planteo al cliente. |
| Qué declara el bloque | Sesiones abiertas (ninguna / cuál) + caminos del local (pedidos / reservas). |
| Tono de las líneas | **Facts**, nunca guion. Prohibido texto que invite a recitar “¿querés pedir o reservar?”. |
| Cuándo se emite | Solo en turno sin dueño de dominio. Con sesión viva el mapa es ruido. |
| ¿El mapa nombra tools? | **No.** Las descripciones de tools ya dicen qué puerta abre cada una; duplicar `start_reservation_session` en el ledger contamina. |
| Línea de personas del pedido | Se queda en el **dato**, sin instrucción: `no informado` en turno frío, `no aplica` en `reservations_only`. La puerta de reserva ya vive en el system prompt. |
| `reservation_draft` sin sesión activa | **No** saca el turno del mapa. Tratarlo como sesión viva hace volver el imperativo de pedido tras el handback; `blocksOrderPartySizeForReservationDomain` ya ignora el draft solo, a propósito. |
| Capacidad ausente en el contexto | **Omitir el mapa.** Inventar “toma pedidos y reservas” cuando el dato no llegó es peor que el sesgo actual. |
| Camino del dueño (owner assistant) | Sin mapa: ese camino no evalúa capacidades. |
| Fuente de capacidades | Reusar lo que ya calcula `capabilityAccessGateNode`; **prohibido** recalcular `evaluateBusinessCapabilityAccess` dentro de `contextMessage` (2 queries extra por turno). |
| Horario del local | **No** entra al mapa. Local cerrado ya corta antes; si opera cerrado, queda en su Alert. |

## Enfoque

### Fase 1 — Propagar capacidades al contexto del ReAct

- `capabilityAccessGateNode` ya corre `evaluateBusinessCapabilityAccess(business.id, businessConfig)`
  por turno y descarta el resultado salvo `mode === 'blocked'`. Guardarlo en `AgentState`.
- Propagar a `EnrichedContext` con el mismo patrón que `hasAddress` / `isInCoverage`
  (“propagado desde AgentState para el contexto del ReAct agent”).
- Campos que importan: `mode`, `canOrder`, `hasReservations`.
- **Ese patrón se copia a mano en varios puntos** (`dispatch/index.ts` para el híbrido, otro
  para checkout) y hay caminos que no lo copian —el handback de reserva no pasa `hasAddress`—.
  Asumir que va a pasar lo mismo con capacidades: el campo es opcional y su ausencia
  **omite el mapa**, nunca lo rellena con un default optimista.

### Fase 2 — Líneas de estado de dominio

Helper nuevo (`domainStateContextLines` o similar), emitido **antes** de la línea de personas.

Condición de “turno frío”:

- sin `checkout_active`
- sin `reservation_agent_active` ni `reservation_faq_delegation`
- sin onboarding activo
- sin carrito con ítems
- **con o sin** `reservation_draft`: el draft solo no rompe el turno frío
- capacidades presentes en el contexto (si no llegaron, no hay mapa)

Incluye el **primer mensaje de pedido real** (*“quiero un ceviche”*, sin carrito todavía):
ese turno también es frío y también pierde el imperativo. Ver Fase 3.

Salida esperada, local `full`:

```
- Sesión: ninguna abierta (sin pedido en armado, sin reserva, sin checkout).
- El local toma: pedidos y reservas de mesa.
```

Local `reservations_only`:

```
- Sesión: ninguna abierta.
- El local toma: solo reservas de mesa. NO toma pedidos por este chat.
```

Local `orders_only`: no mencionar reservas (para no inventar una puerta inexistente).

Turno frío **con** `reservation_draft` (post-handback): el mapa se emite igual, pero la línea
de sesión no puede decir “sin reserva” porque el borrador existe. Reporta ambas cosas:

```
- Sesión: ninguna abierta. Hay una reserva en borrador sin sesión (no la retomes por tu cuenta).
- El local toma: pedidos y reservas de mesa.
```

### Fase 3 — Desinclinar la línea de personas

En turno frío la línea se queda en el dato, **sin instrucción de ningún tipo**:

```
- Personas para el pedido: no informado
```

En `reservations_only`:

```
- Personas para el pedido: no aplica (este local no toma pedidos)
```

Reemplazar “preguntá PRIMERO” por “si enmarca reserva llamá `start_reservation_session`”
sería el mismo error con otro destino: una orden pegada al mensaje del cliente. La puerta de
reserva ya está en el system prompt; el ledger solo reporta estado.

Sin esta fase, el mapa compite contra el imperativo y se pierde igual.

**Costo asumido:** el turno del primer pedido real (*“quiero 1 ceviche, 2 papas…”*, sin
carrito) deja de traer el empujón a preguntar personas. La recuperación es la vuelta de
`party_size_required` desde el gate de tools, que **no se toca** (norma D6/D7 intacta).

### Fase 4 — Tests + espejo

- **Reescribir** `contextMessage.test.ts` › *“sin party size: ledger indica preguntar si
  Goal/tool lo pide (antes de shortlist)”*: hoy exige `preguntá PRIMERO` y `party_size_required`
  en el ledger con el mensaje *“Quiero 1 ceviche, 2 papas a la huancaína y una chicha”*. Ese
  turno pasa a ser frío y la línea queda en `no informado` seco.
- Turno frío `full` / `reservations_only` / capacidades ausentes (sin mapa) / sesión viva (sin mapa).
- Draft de reserva sin sesión: el mapa **sí** se emite.
- Espejo en food-service-agent: **después** de validar conversaciones en gesty-backend. No entra en este cambio.

Los tests cubren el bloque, no la respuesta del modelo: que el ledger no diga “¿pedido o
reserva?” no garantiza que el bot no lo pregunte. Esa parte se valida con conversación real
(ver Riesgos).

### Fase 5 — Comando de cancel = wipe del dominio nombrado (no del dueño del turno)

Evidencia 21/9 (`5493413867990`): con `reservation_agent_active`, “Cancelar pedido”
lo tragaba el agente de mesas; sin sesión, “Cancelar reserva” cancelaba el **pedido
confirmado**.

- Helper `resolveDomainCancelCommand({ payloadId, userMessage })` → `'order' | 'reservation' | null`.
- Payloads: `CANCEL_ORDER`, `CANCEL_TARGET:*`, `CANCEL_CHECKOUT` → order;
  `RESERVATION_CANCEL` → reservation.
- Texto: tipables “Cancelar pedido” / “Cancelar reserva” (y variantes con cancel/borr +
  pedido|carrito|todo / reserv). **No** intercepta “sí, cancelar” (pending switch).
- Aplicar **antes del ReAct** en: `reservationAgentNode`, `nlpSubgraphNode`, `checkoutAgentNode`.
- Order → `buildCancelOrderMessage`. Reservation → `clearReservationSessionAfterCancel`
  + copy *Reserva cancelada*.
- Archivos: `src/services/domainCancelCommand.service.ts` + tests.

### Fase 6 — Lienzo en blanco si no queda dueño

Tras cada wipe de dominio, si no hay carrito, checkout, sesión/draft de reserva ni
onboarding: `metadata: {}`, `mode: GLOBAL`, `lastReferencedProductId: null`.

- No canvas si el otro dominio sigue vivo (`reservation_draft` o sesión, o carrito).
- `maybeClearConversationCanvas` al final de `clearOrderSessionAfterCancel` y
  `clearReservationSessionAfterCancel`.
- Archivos: `src/services/conversationCanvas.service.ts` + tests.
- **No** cierra la conversación de WhatsApp (el idle sí lo hace; acá no).

### Fase 7 — FAQ de platos para la mesa sin Fact de personas

Log 21/9: `delegate_to_main` reason `sugerir platos para 1 por raciones` **sin**
`save_reservation_party_size`. El `1` no es Fact. El híbrido llamó
`suggest_dishes_for_party_size` sin args y narró “sesión activa”; el nodo anexó
resume de **fecha** + “¿seguimos o cancelás?”.

- Gate en el nodo **antes** de FAQ: si `delegateToMain` es sugerencia de platos y
  `reservation_draft.partySize` no es un entero ≥ 1 → **no** `delegate_to_main`,
  **no** resume. Solo `ASK_RESERVATION_PARTY_SIZE_FOR_DISHES`.
- El reason no cuenta como N.
- `suggest_dishes_for_party_size`: `partySize` opcional; si falta, lee el draft;
  si tampoco hay N → `reservation_party_size_required` (PROHIBIDO re-llamar
  `start_reservation_session` ni narrar la sesión).
- Archivos: `src/services/reservations/dishFaqPartySizeGate.ts`,
  `src/graph/nodes/reservation/index.ts` (bloque `delegateToMain`),
  `src/tools/index.ts` (`suggestDishesForPartySizeTool`).
- Tests: `dishFaqPartySizeGate.test.ts`, `suggestDishesForPartySize.test.ts`,
  `reservationAgentNode.test.ts` › FAQ platos sin partySize.

Turno esperado: “qué platos sirven para la reserva” → abre sesión → *¿Para cuántas
personas?* (sin fecha ni cancelar). Siguiente turno con N guardado → FAQ de platos
+ resume de fecha.

### Fase 8 — Fact `pendingReservationDishFaq` (FAQ adeudada)

Evidencia 21/9 (`Somos 6` tras el gate): el nodo persistía N y el ReAct leía
`Paso actual: date` (“fuente de verdad, no sugerencia”). El bullet MENÚ PARA
LA MESA perdía. El bot mencionaba platos y pedía fecha; no había Fact de
“debo FAQ”.

- Al bloquear Fase 7: persistir `pendingReservationDishFaq` `{ reason,
  originalUserMessage, setAt }`.
- Con pending + `partySize` entero ≥ 1: el **nodo** corre `delegate_to_main`
  **antes del ReAct** (y si el tipable de personas acaba de guardar N). No
  esperar al modelo. El híbrido recibe la **consulta original** de platos (no
  “Somos 6”) + snapshot con N.
- Ledger reserva: si hay pending, el paso fecha **no aplica** ese turno.
- Ledger híbrido: reason de platos → `suggest_dishes_for_party_size` YA.
- Wipe de reserva omite `pendingReservationDishFaq`.
- Archivos: `src/services/reservations/pendingReservationDishFaq.ts`,
  `reservation/index.ts` (`fulfillOwedReservationDishFaq`),
  `reservationAgent.ts` (líneas de pending),
  `reservationFaqDelegation.service.ts`,
  `reservationSessionReset.service.ts`.
- Tests: `pendingReservationDishFaq.test.ts`,
  `reservationAgentNode.test.ts` › FAQ platos con Fact pendiente + N.

Turno esperado: *platillos* → pide N (queda pending) → “Somos 6” → shortlist
+ solo seguir/cancelar (Fase 10). **No** fecha ni horarios en ese turno.

### Fase 9 — Shortlist de raciones con fallback `cover` (sin LLM)

Evidencia 21/9 (`Para 3`): FAQ corrió y `suggest_dishes` resolvió N=3, pero el
filtro `[N, N+2]` dejó `count: 0`. El híbrido dijo que no había platos; el
resume de fecha se pegó igual.

- Ranking **dentro de la tool** (no chain, no segundo LLM): `exact` → `near`
  (N..N+2) → si vacío, `cover` (`suggestedUnits = ceil(N/serves)`, misma
  fórmula D2 que pedido) → si vacío, `over`.
- Query: `serves_people` not null (pool acotado). El ReAct solo ve el
  shortlist + `match` / `suggestedUnits` / `note`.
- Copy al cliente = pedido: `• *Nombre*` + `ración para: N` (`displayLine`).
  `suggestedUnits` / `cubre` son internos; **prohibido** en el mensaje.
  Si `cover`: una frase al final (más de una unidad), no fórmula por renglón.
  Ajuste 22/9: esa frase es **solo fuera de reserva**. Con `reservationActive`
  (`isReservationFaqMode`) el `instruction` la prohíbe y además prohíbe todo
  cierre propio del modelo: el turno cierra con la pregunta fija de Fase 10.
  Al redactar esa prohibición **no citar** la pregunta de Fase 10: en el e2e
  del 22/9 el modelo la copió literal y salió repetida. Red determinística:
  `appendResumeFollowUp` no anexa si el texto ya la trae.
- Pedido **no** cambia: sigue sin filtrar por ración.
- Archivos: `src/services/reservations/rankDishesForPartySize.ts`,
  `src/tools/index.ts` (`suggestDishesForPartySizeTool`).
- Tests: `rankDishesForPartySize.test.ts`, `suggestDishesForPartySize.test.ts`
  › mesa de 3 / plato de 2. E2E: `reservation-production.e2e.test.ts`
  › `faq-platos-cierre-unico` (lista + una sola pregunta, sin frase de unidades).

### Fase 10 — Resume FAQ: solo seguir/cancelar (sin fecha ni hora)

Evidencia 21/9 post-platos: el híbrido pedía “continuar… ¿día y hora?” y el
nodo anexaba *Seguimos… ¿para qué día?* + *¿seguimos o cancelás?*. Tres CTAs;
el horario no puede ir en prosa (slots = lista del agente de reservas).

- `includeContinueOrCancel: true` → **solo** `RESERVATION_FAQ_CONTINUE_OR_CANCEL`.
  No concatenar `nextReservationDraftQuestion`.
- Prompt FAQ + instruction de `suggest_dishes`: PROHIBIDO fecha / horario /
  “día y hora”. El menú cierra el turno del híbrido.
- Fecha y `get_available_slots` (lista) en el turno siguiente si el cliente sigue.
- Archivos: `buildResumeFollowUp.ts`, `botPersonality.ts`,
  `rankDishesForPartySize.ts` (instruction).
- Tests: `buildResumeFollowUp.reservationFaq.test.ts`,
  `reservationAgentNode.test.ts` › FAQ + N (sin “para qué día”).

### Fase 11 — Abrir la mesa cierra el dominio pedido (error recuperable)

Evidencia 21/9 (“Buenas quiero reservar Pero quería saber si tienen ceviche”): el
híbrido eligió la puerta de **pedido** (`search_products`), el gate le devolvió
`party_size_required` — que **afirma** el marco pedido — y con “Somos 8” escribió
`peopleCount` de pedido. `reservation_delegated: false` en los dos turnos: las
Fases 7–10 viven dentro de la rama de reserva y **no corrieron**.

Diagnóstico: la elección de dominio es del LLM y el único Fact que apaga la
maquinaria de pedido (`reservation_agent_active`) lo produce esa misma elección.
No se puede llevar esa elección al 100%; sí se puede hacer que equivocarse **no
sea terminal**.

Agujero concreto: el wipe del dominio pedido solo se alcanzaba por la rama de
**cancelar carrito** (`cartItems > 0` → confirmar → `clearOrderSessionAfterCancel`).
Con carrito vacío, `start_reservation_session` abría la sesión y `peopleCount`,
shortlist, `pendingProductSelection`, `pendingAddQuantity`, CTA y Ledger de
pedido entraban **vivos** a la reserva. El nodo solo descartaba
`requestedPartySize` / `peopleCount` — y los tiraba en vez de adoptarlos.

- **Invariante:** abrir sesión de reserva es un cambio de dominio ⇒ wipe del
  dominio saliente. Espejo de `clearReservationSessionAfterCancel`.
- **Lectura fresca obligatoria.** `wsMeta` es el snapshot previo al híbrido; el
  caso principal es `save_party_size` + `start_reservation_session` en el MISMO
  turno, donde el Fact ya está en la DB pero no en el snapshot. Con `wsMeta` la
  adopción se saltea justo cuando hace falta (log 22/9: `adoptedPartySize: null`
  con `save_party_size` en el `tool_trace` del mismo turno).
- **Adopción antes del wipe:** “somos 6” es el mismo Fact en los dos dominios;
  si el draft no tiene `partySize`, se adopta. El cliente **no repite el dato**.
  Solo completa huecos (gana el draft). Un número arrastrado de un pedido
  anterior es visible en la tarjeta de confirmación antes de crear la reserva.
- `clearOrderDomainOnReservationOpen` **no** toca `welcomeEligible` (el nodo lo
  apaga en el mismo turno) ni el canvas (la reserva es la nueva dueña).
- Efecto de borde: con N adoptado, la FAQ adeudada de la Fase 8 se resuelve sola.
- El copy de `party_size_required` (“van a comer”) queda **cosmético**: cuesta un
  mensaje raro, ya no rompe la conversación. No se parchea.

Fuera: router/clasificador de dominio. Con el error recuperable, la precisión del
primer paso deja de ser crítica; el router se decide con desvíos medidos en dev.

### Fase 12 — Tools informativas no siembran estado de otro dominio

Evidencia 21/9 (“Hola buenas quería reservar Pero quiero saber si tienen ceviche”):
el híbrido delegó bien (`start_reservation_session` ✓, Fase 11 ✓), pero en la FAQ
mid-reserva llamó `present_product_cta(SELECT_FROM_LIST)` y dos turnos después
`add_cart_item` → *“Sumé 1× Ceviche Clásico al pedido. Total: $100”* en medio de una
reserva, más una oferta de complementos. **Las tres cosas están prohibidas por
nombre** en la sección `DELEGACIÓN FAQ MID-RESERVA` del prompt: el prompt no es
enforcement (ADR-0002).

Causa mecánica: `search_products` es informativa pero su resultado **ordena** la
acción de pedido (`instruction: llamá present_product_cta(SELECT_FROM_LIST)`) y
**escribe** `pendingProductSelection` + `candidateProductIds` vía
`markShortlistAwaitingChoice`. Ese pending sobrevive turnos, entra al bloque de
estado con los candidatos resueltos a nombre (`buildPendingProductSelectionLines`)
y es el blanco que usó el `add_cart_item`. El modelo obedeció al tool result.

Solo ocurre con **≥2 resultados** (`if (productIds.length < 2) return`): de ahí que
la misma consulta a veces no deje rastro y a veces tuerza la conversación.

- `readOrderingTurnScope(conversationId)`: lee el estado **una vez** y devuelve
  `{ partyGate, reservationTurn }` (`isReservationFaqMode`). Reemplaza a
  `partySizeOrderingGateJson` en las dos tools; no agrega queries.
- Turno de reserva ⇒ **no** `markShortlistAwaitingChoice` y la instruction pasa a
  `RESERVATION_MENU_DATA_INSTRUCTION` (dato: nombre / ración / precio; prohibido
  invitar a elegir, armar pedido o sumar al carrito; para la mesa,
  `suggest_dishes_for_party_size`).
- Turno de pedido: idéntico a antes (`SHORTLIST_CHOICE_INSTRUCTION`).
- Alcance: `search_products` y `find_products_by_filter` — los dos únicos call sites
  de `markShortlistAwaitingChoice`. El resto de escrituras en `tools/index.ts` son
  tools de acción de pedido (`add_cart_item`, `save_party_size`, variación, nota).

### Fase 13 — El pool de `suggest_dishes_for_party_size` se arma por proximidad a N

Evidencia 22/9 (mesa de 6, “y tienen pollo?”): la tool devolvió *Chicha morada*,
*Pisco sour*, *Suspiro a la limeña*, *Alfajores*… todo `ración para: 1`, con la frase
de fallback `cover`. Parecía falta de foco (keyword perdida) y no lo era.

Estado real de la base de develop (consultado 22/9, businesses de dev):

| `serves_people` | 1 | 2 | 3 | 4 | 6 | null |
|---|---|---|---|---|---|---|
| ítems disponibles | 170 | 46 | 27 | 4 | **12** | 115 |

| `category_tag` | DRINK | MAIN | STARTER | SIDE | DESSERT | OTHER |
|---|---|---|---|---|---|---|
| categorías | 17 | 16 | 13 | 4 | 3 | 1 |

Dos conclusiones: hay **12 platos que sirven exactamente para 6** (el tier `exact`
tenía con qué), y las categorías **sí** están tagueadas (el rol es usable como filtro).

Causa mecánica: el pool era `orderBy serves_people asc` + `take ≤ 80`. Con 170 ítems
de una porción, esos 80 son **todos** `serves=1`: los platos para N nunca entran al
pool, el ranking no puede verlos y cae en `cover` por descarte. El criterio de
selección de candidatos no tenía relación con N. Por lo mismo el `cover` proponía lo
peor (6 unidades de un plato para 1) en vez de 2 unidades de uno para 3: los `serves`
grandes tampoco llegaban. `rankDishesForPartySize.ts` estaba bien — no se tocó.

- Dos consultas disjuntas e indexadas por `serves_people`, en `Promise.all`:
  `gte N` orden **asc** (exact / near / over, el más cercano primero) y
  `gte 1, lt N` orden **desc** (cover, el plato más grande primero = menos unidades).
  `take` por consulta: `min(40, max(12, limit * 4))`.
- Filtro de rol: sin keyword, `category_tag notIn [DRINK, DESSERT]` — una bebida o un
  postre no es “plato para la mesa”. **Con** keyword no se filtra: el foco lo puso el
  cliente (si pide “pisco”, la respuesta es el pisco).
- Keyword: el trace de la conversación mala es `suggest_dishes_for_party_size` con
  `args:{}` — el modelo **no** pasó `pollo`, así que la lista fue el catálogo alfabético.
  La `description` de la tool no nombraba el parámetro. Ahora lo declara obligatorio
  cuando la consulta menciona un plato o ingrediente, y vacío solo para la
  recomendación general. Lever de prompt/schema, **no** regex sobre el mensaje.
- Copy: la instruction prohíbe además ofrecer *“agregar alguno a la reserva”* — es una
  capacidad que no existe (la reserva guarda la mesa, no platos) y el bot la ofreció.

Alcance real por negocio (importante para validar): el negocio de prueba
(`e89dfb88…`, menú peruano) tiene **99 ítems `serves=1` y 1 de 2** — ningún plato de 4+.
Los 12 platos para 6 son de otros negocios de dev. Ahí `cover` **es** la respuesta
correcta para una mesa de 6: lo que arregla la lista en ese menú es el filtro de rol
(saca *Chicha morada*, *Pisco sour*, *Suspiro a la limeña*, *Alfajores*, *Algarrobina*:
5 de los 10 renglones) más la keyword. El pool por proximidad se nota en los negocios
con raciones grandes cargadas.

### Fase 14 — La lista de horarios depende del borrador, no del modelo

Complementa la Fase 10 (en el turno de FAQ no se piden fecha ni horarios), pero del
lado del enforcement: el prompt pedía “solo llamar cuando la fecha ya está guardada” y
el prompt no es enforcement (ADR-0002).

- `get_available_slots` lee el borrador y **no emite señal** si falta la fecha
  (`{ presented: false, error: 'date_required' }`) o si el arg no coincide
  (`date_mismatch`, con `draftDate` para que el modelo sepa qué guardar).
- La señal viaja con la fecha **canónica del borrador** (`date: draft.date`), no con la
  que dedujo el modelo. `normalizeDate` tolera `DD/MM` sin año, así que el arg abreviado
  del modelo sigue matcheando la fecha guardada.
- El gate va **solo en la tool**: `extractSignals` toma `date` del *resultado*, así que
  si la señal existe el borrador ya tenía fecha. Duplicarlo en el nodo era inalcanzable
  y agregaba una décima lectura del mismo row en el turno.
- Tests: `reservation.test.ts` (`date_required`, `date_mismatch`, fecha canónica) y
  `reservationAgentNode.test.ts` (camino feliz: señal ⇒ lista interactiva; sin slots ⇒
  aviso en texto). El camino feliz no tenía cobertura y es la ruta principal de la reserva.

Siguiente paso (**separado**, no en esta fase): recortar el toolbox del híbrido por
dueño de turno. Se decide con datos de `tool_trace`, no por criterio. El eje **no**
es lectura/escritura: `search_products` lee, escribe y ordena — la clasificación
tiene que ser por tool, y las informativas se quedan (si no, se pierden respuestas).

## Fuera de alcance

- Clasificador LLM de dominio por turno (la “opción 2” pendiente). Se posterga a
  propósito tras la Fase 11: primero reversibilidad, después medir desvíos.
- Neutralizar `PARTY_SIZE_REQUIRED_TOOL_PAYLOAD` (“personas que comen”) para que
  el tool result no afirme dominio. Cosmético una vez que el error es recuperable.
- Reinstalar detección NLP: hoy el híbrido corre con `NLP_AGENT_FIRST_DETECTION` (intent
  `UNKNOWN` fijo), así que la Fase A de `isFoodRelatedPartySizeSignal` está muerta.
- Tocar el gate de party size en tools de catálogo (norma D6/D7: personas antes del shortlist).
- Rebalancear el toolbox (~45 tools de pedido vs 1 puerta de reserva).
- **Corte de historial** (`sessionResetAt` / filtrar `buildAgentHistoryMessages`): el “3”/“4”
  y que “Tienen ceviche?” caiga en reserva salen de los últimos 12 turnos. Queda para
  después de validar Fases 5–10.
- Inventar fecha/slots en el turno “Somos 6” (el agente guardó el 22/09 sin que el
  cliente lo dijera). Otro bug; no mezclar en este plan.

## Riesgos

| Riesgo | Mitigación |
|--------|-----------|
| El modelo parafrasea el mapa y pregunta “¿pedido o reserva?” ante “hola” o “qué tienen” | **No hay mitigación por test.** La regla “ESTADO DEL CLIENTE es contexto interno” ya existía y no impidió el `save_party_size` del 21/9. Se valida con conversaciones reales en dev (saludo, consulta vaga, pedido directo, consulta enmarcada en reserva) antes de dar por buena la fase |
| Pérdida del empujón a party size en el primer pedido real | Asumido; lo recupera `party_size_required` del gate de tools (sin cambios) |
| Mapa inventado cuando la capacidad no llegó al contexto | Campo opcional; ausencia ⇒ sin mapa. Nunca default optimista |
| Tokens extra por turno | Solo en turno frío; 2 líneas |
| Queries extra | Reusar el cómputo del gate; nunca recalcular en `contextMessage` |
| Frontera ADR-0008 (Intent activo lo decide el ranker, no el LLM) | Se declaran **Facts**, no Intents. La elección de puerta de dominio ya es del LLM de facto (llama `start_reservation_session` o no); esto la hace explícita |

## Checklist

- [x] Fase 1: capacidades en `AgentState` → `EnrichedContext`
- [x] Fase 2: líneas de estado de dominio en turno frío
- [x] Fase 3: `partySizeLine` en turno frío queda en el dato (`no informado` / `no aplica`)
- [x] Fase 4 (este repo): reescribir test que exige `preguntá PRIMERO` + casos nuevos
- [x] Fase 5 (este repo): comando cancel → wipe del dominio nombrado
- [x] Fase 6 (este repo): lienzo `{}` si no queda dueño
- [x] Fase 7 (este repo): FAQ de platos bloqueada sin `reservation_draft.partySize`
- [x] Fase 8 (este repo): Fact `pendingReservationDishFaq` + FAQ en el nodo cuando hay N
- [x] Fase 9 (este repo): shortlist exact/near/cover (`ceil(N/serves)`), sin LLM de copy
- [x] Fase 10 (este repo): resume FAQ = solo seguir/cancelar (sin fecha/hora)
- [x] Fase 11 (este repo): abrir la mesa adopta N y cierra el dominio pedido
- [x] Fase 12 (este repo): `search_products` / `find_products_by_filter` no siembran
      pending de pedido ni ordenan CTA en turno de reserva
- [x] Fase 13 (este repo): pool de `suggest_dishes_for_party_size` por proximidad a N
      (dos consultas) + sin bebidas/postres cuando no hay keyword
- [x] Fase 14 (este repo): `get_available_slots` exige fecha en el borrador; gate en la
      tool, no en el nodo; camino feliz cubierto por test
- [x] Validación conversacional Fase 14: fecha → lista de horarios sigue saliendo (no
      debe aparecer `date_required` en el turno donde el cliente sí dio la fecha)
- [x] Validación conversacional Fase 13 (negocio `e89dfb88…`): mesa de 6 → “y tienen pollo?”
      responde solo platos con pollo (trace con `keyword`), sin bebidas ni postres y sin
      ofrecer “agregar a la reserva”; “qué platos me recomendás” → comida, no bebidas
- [x] Validación conversacional Fase 12: “quería reservar pero tienen ceviche?” →
      responde el dato sin lista de selección; turnos siguientes sin `add_cart_item`
- [ ] Toolbox por dueño de turno (fase aparte, después de validar la 12)
- [x] Validación conversacional Fase 11: puerta equivocada (“quiero reservar pero tienen
      ceviche?” → pedido) y recuperación en un mensaje (“era para reservar”) con el N ya cargado
- [x] Fases 5–11 (espejo): food-service-agent — runtime ya estaba; se portó la red de tests
- [x] Fase 4 (espejo): food-service-agent — tests de mapa + `capabilityAccessGate`
- [x] Validación conversacional en dev: … FAQ platos → lista + solo “¿seguimos o cancelás?” (sin día/hora); si sigue → fecha y slots en lista
- [x] `docs/FEATURES.md` BOT-07 (`en desarrollo`) + BOT-01 / RES-05 en historial
- [x] Re-test manual de la conversación del 21/9
- [ ] Corte de historial (fuera de este sprint de código)

## Abiertos

Ninguno. El horario no entra al mapa (ver Decisión de producto).

Resueltos en el audit del 21/9: el draft sin sesión **no** rompe el turno frío; el mapa **no**
nombra tools; sin capacidades en el contexto **no** hay mapa.

## Mapa de archivos (espejo food-service-agent)

Copiar con el mismo contrato; no inventar `tryHandle*` / regex pre-ReAct para tipables.

| Fase | Crear | Tocar |
|------|--------|--------|
| 1 | — | `src/graph/state.ts` (`capabilityAccess` en `AgentState`); `src/controllers/webhook/types.ts` (`EnrichedContext`); `src/graph/nodes/gates/index.ts` (persistir el resultado del gate, no solo `blocked`); `src/graph/nodes/context/index.ts` (copiar a `enrichedBase`) |
| 2–3 | `src/agents/domainStateContext.ts` | `src/agents/contextMessage.ts` (`domainStateContextLines` **antes** de `partySizeLine`; línea de personas sin “preguntá PRIMERO” en turno frío) |
| 4 | — | `src/agents/__tests__/contextMessage.test.ts`; `src/graph/nodes/gates/__tests__/capabilityAccessGate.test.ts` |
| 5 | `src/services/domainCancelCommand.service.ts` + `__tests__/domainCancelCommand.test.ts` | `src/graph/nodes/reservation/index.ts`, `src/graph/nodes/dispatch/index.ts`, `src/graph/nodes/checkout/index.ts`: resolver **antes del ReAct**; order → `buildCancelOrderMessage`; reservation → `clearReservationSessionAfterCancel` + copy *Reserva cancelada* |
| 6 | `src/services/conversationCanvas.service.ts` + `__tests__/conversationCanvas.test.ts` | `clearOrderSessionAfterCancel` / `clearReservationSessionAfterCancel` llaman `maybeClearConversationCanvas` al final. Condición: sin carrito, checkout, sesión/draft de reserva, onboarding → `metadata: {}`, `mode: GLOBAL`, `lastReferencedProductId: null` |
| 7 | `src/services/reservations/dishFaqPartySizeGate.ts` + tests | `reservation/index.ts`: bloque `delegateToMain` **antes** de FAQ; copy `ASK_RESERVATION_PARTY_SIZE_FOR_DISHES` (título *¿Para cuántas personas?*, **sin** resume de fecha ni CTA cancelar). `src/tools/index.ts` `suggestDishesForPartySizeTool`: `partySize` opcional; resuelve desde `reservation_draft`; sesión ausente → `reservation_session_required`; sesión sin N → `reservation_party_size_required` (instruction **no** debe empujar `start_reservation_session`). Tests: `suggestDishesForPartySize.test.ts`, `reservationAgentNode.test.ts` › FAQ platos sin partySize |
| 8 | `src/services/reservations/pendingReservationDishFaq.ts` + tests | Al bloquear Fase 7: `pendingReservationDishFaq`. Con pending + N: `fulfillOwedReservationDishFaq` **antes del ReAct** (híbrido con `originalUserMessage`). Omitir la clave en `clearReservationSessionAfterCancel`. Ledger reserva: pending + N ⇒ fecha no aplica. Ledger híbrido: reason de platos ⇒ `suggest_dishes` YA. Tests: `reservationAgentNode.test.ts` › FAQ platos con Fact pendiente + N |
| 9 | `src/services/reservations/rankDishesForPartySize.ts` + tests | `suggestDishesForPartySizeTool`: pool `serves_people` not null; rank exact → near → cover (`ceil`) → over. JSON: `bestMatch`, `suggestedUnits` (interno), `displayLine` / `note` = pedido (`• *Nombre*` / `ración para: N`). Instruction: no copiar `3×`/`cubre`. Sin chain LLM. |
| 10 | — | `buildResumeFollowUp.ts`: FAQ → solo D3. `botPersonality.ts` + instruction tool: no fecha/hora. Tests resume FAQ + nodo FAQ + N. |
| 12 | `src/tools/__tests__/informativeToolsReservationTurn.test.ts` | `src/tools/index.ts`: `readOrderingTurnScope` (una sola lectura de estado) + `SHORTLIST_CHOICE_INSTRUCTION` / `RESERVATION_MENU_DATA_INSTRUCTION`; `search_products` y `find_products_by_filter` saltan `markShortlistAwaitingChoice` y cambian la instruction si `reservationTurn` |
| 14 | — | `src/tools/reservation.ts` `getAvailableSlotsTool`: lee `readReservationDraft`; `date_required` / `date_mismatch`; señal con `date: draft.date`. `botPersonality.ts`: la línea de la tool declara el gate. `TAXONOMIA.md`: fila de personas nombra `search_products` / `present_*` / `add_cart_item`. El nodo **no** duplica el gate. Tests: `reservation.test.ts` + camino feliz en `reservationAgentNode.test.ts` |
| 13 | — | `src/tools/index.ts` `suggestDishesForPartySizeTool`: pool en dos `findMany` (`gte N` asc / `gte 1, lt N` desc), `take = min(40, max(12, limit*4))` por consulta; sin keyword `menu_category.category_tag notIn [DRINK, DESSERT]`. `rankDishesForPartySize.ts` **no** se toca. Tests: `suggestDishesForPartySize.test.ts` (mocks por consulta con `mockResolvedValueOnce`; asserts de `where.serves_people` / `orderBy` / filtro de rol) |
| 11 | `src/services/reservations/adoptOrderPartySize.ts` (lee metadata **fresca** con prisma, NO recibe `wsMeta`) + `__tests__/adoptOrderPartySize.test.ts` | `src/services/orderSessionReset.service.ts`: extraer `wipeOrderDomainState(id, { welcomeEligible })` y exportar `clearOrderDomainOnReservationOpen` (sin `welcomeEligible`, sin canvas, sin cancelar draft). `src/graph/nodes/reservation/index.ts`: en el bloque “activar sesión en el primer turno”, reemplazar el omit de `requestedPartySize`/`peopleCount` por adoptar → wipe, con log `order_domain_closed_on_open` (`adoptedPartySize`). Tests: `reservationAgentNode.test.ts` › adopta N y cierra dominio pedido / no sobrescribe `partySize` del draft |

Copy del gate Fase 7: `formatBotUserMessage('¿Para cuántas personas?', '👥', 'Para recomendarte platos que sirvan para la mesa, necesito saber cuántas personas van a asistir.')`.

Reason de `delegate_to_main` que dispara el bloqueo (normalizado, sin tildes): `sugerir platos`, `platos para`, `por raciones`, `que platos`, `menu para la mesa|reserva`. El número en el reason **no** cuenta como Fact.

## Referencias de código

- Bloque de estado: `src/agents/contextMessage.ts` (armado de `lines`, `partySizeLine`)
- Mapa de dominio: `src/agents/domainStateContext.ts`
- Capacidades: `src/services/evaluateBusinessCapabilityAccess.service.ts`,
  `src/graph/nodes/gates/index.ts` (`capabilityAccessGateNode`)
- Precedente capability-aware en UI: `src/services/smallTalk.service.ts`
- Contexto propagado: `src/controllers/webhook/types.ts` (`EnrichedContext`)
- Dominio reserva activo: `src/services/partySizeGoal.service.ts`
  (`blocksOrderPartySizeForReservationDomain`)
- Cancel por dominio: `src/services/domainCancelCommand.service.ts` (gates en
  `reservation/index.ts`, `dispatch/index.ts`, `checkout/index.ts`)
- Lienzo: `src/services/conversationCanvas.service.ts`
- FAQ platos sin N: `src/services/reservations/dishFaqPartySizeGate.ts`
- FAQ platos adeudada: `src/services/reservations/pendingReservationDishFaq.ts`
- Ranking raciones: `src/services/reservations/rankDishesForPartySize.ts`
- Cambio de dominio pedido → reserva: `src/services/reservations/adoptOrderPartySize.ts`,
  `clearOrderDomainOnReservationOpen` en `src/services/orderSessionReset.service.ts`,
  rama con carrito en `src/services/switchToReservationConfirm.service.ts`
- Handoff menú↔reserva: `PLAN-ACCION-RESERVA-MENU-PORCIONES-HANDOFF.md`
