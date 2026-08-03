# Registro de violaciones al modelo

**Estado:** vivo. Se actualiza en cada PR que corrige o introduce una violación.
**Referencia:** [`ARQUITECTURA.md`](../../ARQUITECTURA.md) · [`docs/adr/`](../adr/)
**Última revisión:** 2026-07-13

**Criterio de priorización:** el orden **no** es por elegancia arquitectónica sino por **riesgo en producción × costo de corregir**. Una violación conceptualmente grave pero inerte va después de una violación menor que se cobra pedidos todas las semanas.

---

## Resumen

| # | Violación | ADR violado | Severidad | Esfuerzo | Prioridad |
|---|---|---|---|:-:|:-:|:-:|
| ~~V-01~~ | ~~Eliminación de ítems sin confirmación exigida~~ | 0002 | ✅ **Corregida** | — | — |
| ~~V-02~~ | ~~Sin detección determinista de escalamiento a humano~~ | 0002 | ✅ **Corregida** | — | — |
| ~~V-03~~ | ~~Reserva pausada bloquea el routing~~ | 0001 | ✅ **Ya corregida** | — | — |
| ~~V-04~~ | ~~El worker de expiración borra el estado de otras capas~~ | 0007 | ✅ **Ya corregida** | — | — |
| **V-05** | Reglas transaccionales viviendo solo en prompts | 0002 | 🟠 Alta | Medio | **P1** |
| ~~V-06~~ | ~~Reconciliador de pending del checkout~~ | 0012, 0006 | ✅ **Corregida** | — | — |
| ~~V-07~~ | ~~`COMPLETAR_PEDIDO` no existe (la continuidad no está representada)~~ | — | ✅ **Corregida** | — | — |
| ~~V-08~~ | ~~Pending del checkout persistido (FSM en una fila)~~ | 0006 | ✅ **Corregida** | — | — |
| **V-09** | `awaiting_address` fusiona Ownership, Goal y Opportunity | 0001 | 🟠 Alta | Medio | **P2** |
| **V-10** | Presupuesto de insistencia disperso en 6 encarnaciones | 0007 | 🟡 Media | Medio | **P2** |
| **V-11** | Limpieza de un Intent declarado dispersa en ~7 lugares | 0005 | 🟡 Media | Bajo | **P2** |
| **V-12** | TTL de oferta que se guarda y nunca se lee | 0005 | 🟡 Media | Bajo | **P3** |
| **V-13** | ~36 flags en el estado de conversación | 0005 | 🟡 Media | Alto | **P3** |
| **V-14** | Wizard legacy de reservas todavía presente | 0001, 0006 | 🟡 Media | Bajo | **P3** |
| ~~V-15~~ | ~~`COMPLETAR_RESERVA` no existe (continuidad de reservas no representada)~~ | — | ✅ **Corregida** | — | — |
| ~~V-16~~ | ~~Doble mecanismo de confirmación de `remove_cart_item` (duplicación de fuente de verdad)~~ | 0002, 0012 | ✅ **Corregida** | — | — |
| ~~V-17~~ | ~~El checkout no informa costo real de envío ni descuentos por método de pago~~ | — | ✅ **Corregida** | — | — |
| ~~V-18~~ | ~~Elegir método de pago disparaba el cobro sin revisión final del total~~ | 0002 | ✅ **Corregida** | — | — |
| ~~V-19~~ | ~~Onboarding: confirmación de dirección duplicada y contradictoria~~ | 0002 | ✅ **Corregida** | — | — |
| ~~V-20~~ | ~~Onboarding: preguntas laterales (precio/envío) no se delegaban~~ | — | ✅ **Corregida** | — | — |
| ~~V-21~~ | ~~`isInCoverage` con fallback legacy admitía direcciones sin zona real~~ | — | ✅ **Corregida** | — | — |
| ~~V-22~~ | ~~Sin tool para consultar/cambiar dirección o cobertura fuera de una sesión activa~~ | — | ✅ **Corregida** | — | — |
| ~~V-23~~ | ~~Onboarding secuestraba el turno del híbrido tras guardar la dirección~~ | 0001 | ✅ **Corregida** | — | — |
| ~~V-24~~ | ~~Confirmación de dirección: botones no garantizados estructuralmente~~ | 0002 | ✅ **Corregida** | — | — |
| ~~V-25~~ | ~~Checkout: botones de fulfillment/pago/confirmación no garantizados sin señal del LLM~~ | 0002 | ✅ **Corregida** | — | — |
| ~~V-26~~ | ~~`MODIFY_QUANTITY` siempre aditivo (sin cantidad absoluta ni decremento parcial)~~ | — | ✅ **Corregida** | — | — |
| ~~V-27~~ | ~~`TRACK_ORDER` era un intent muerto (ni clasificado ni con handler)~~ | — | ✅ **Corregida** | — | — |
| **V-28** | Sin empuje proactivo hacia armar pedido/reserva (más allá del primer saludo) | — | 🟡 Media | Medio | **P2** |

---

## P0 — Corregir antes de empezar la migración

Estas tres **no dependen del Goal Engine** y no deben esperar cinco fases. Son huecos de seguridad, no de arquitectura.

### ~~V-01~~ · Eliminación de ítems sin confirmación exigida — ✅ **CORREGIDA**
**Violaba:** ADR-0002 (Constraints en el borde de las Tools)

La Tool de eliminación borraba directo. El prompt le pedía al modelo que confirme; **nada lo obligaba**. Era el caso literal de *"si el modelo decidiera ignorar la regla, ¿el efecto ocurriría igual?"* → **sí**.

**Corrección (2026-07-11):** `removeCartItemTool` (`src/tools/index.ts`) ahora exige evidencia de confirmación previa **en el borde de la Tool**, no en el prompt. El primer llamado a `remove_cart_item` para un `productId` nunca elimina: escribe un `pending_item_removal { productId, requestedAt }` en `conversation_state.metadata` (TTL 5 min) y devuelve `requiresConfirmation: true`. Solo un segundo llamado con el **mismo** `productId`, dentro del TTL, ejecuta el borrado — y limpia el pending. La evidencia no es un parámetro que el modelo pueda setear en el mismo schema (eso sería confiar en el llamador, prohibido por ADR-0004): es estado que la propia Tool escribió en una invocación anterior. Test: `src/tools/__tests__/removeCartItem.test.ts`.

---

### ~~V-02~~ · Sin detección determinista de escalamiento a humano — ✅ **CORREGIDA**
**Violaba:** ADR-0002

Dentro de una sesión de checkout o reserva, el turno **nunca llegaba al dispatcher**. Un cliente furioso que pedía hablar con una persona dependía de que el LLM **decidiera** delegar.

**Corrección (2026-07-11):** nuevo nodo `escalationGateNode` (`src/graph/nodes/gates/escalation.ts`), insertado en el grafo principal **entre `messageTypeGuard` y `buildDetectionContext`** — es decir, antes de que Ownership decida qué agente procesa el turno, en todo turno, sin excepción de sesión (`mainGraph.ts`, `routers.ts`: `routeAfterEscalationGate`). Detecta determinísticamente (regex, sin LLM) frases inequívocas de pedido de humano y el botón "Pedir ayuda" (`payloadId === SUPPORT`); si matchea, corta directo a `SEND` con el mismo efecto que `SupportHandler` (`is_human_handled` + evento de socket al admin) y **nunca llega** a checkout/reserva/onboarding/NLP. El dispatcher determinístico original (`SupportHandler`, vía intent `SUPPORT` del LLM) se mantiene intacto como complemento para frases más ambiguas que el regex no cubre. Test: `src/graph/nodes/gates/__tests__/escalation.test.ts`.

---

### ~~V-03~~ · Reserva pausada bloquea el routing — ✅ **YA CORREGIDA**

**Verificado en código (2026-07-11):** `src/graph/nodes/context/index.ts:284` — `reservationBlocksRouting = Boolean(reservationStep) && !reservationPaused`. Una reserva pausada **ya no bloquea** el ruteo hacia otras sesiones.

**Queda la causa raíz, no el síntoma:** mientras el wizard legacy exista, el concepto "reserva pausada" sigue viviendo en un campo de Ownership en vez de ser un Goal. **Ver V-14** — eliminarlo cierra la violación de forma definitiva, no por parche.

---

## P1 — Bloquean o comprometen la migración

### ~~V-04~~ · El worker de expiración borra el estado de otras capas — ✅ **YA CORREGIDA**

**Verificado en código (2026-07-11).** La expiración del borrador **ya no resetea la metadata**: tiene guarda por sesión de checkout activa y ventana de gracia por actividad reciente (`src/workers/draftOrders.ts:60`). El único `metadata: {}` que queda es `resetConversationState()`, y **solo se invoca al cerrar la conversación por inactividad** (`draftOrders.ts:301`) — que es un reset legítimo y deseable: la conversación terminó.

**Nota de diseño que reemplaza a la violación.** Cuando el Ledger viva en el estado de conversación (Fase 0), el cierre por inactividad **también va a borrar el `abandonment` y los `surface_count`**. Eso es **correcto**: conversación nueva, memoria de comportamiento nueva. Cuando el Ledger migre a tabla propia (Fase 2, bloque E), hay que decidir explícitamente si el cierre de conversación lo purga. **La respuesta por defecto es sí** — el Ledger es memoria conversacional, y la conversación terminó.

---

### V-05 · Reglas transaccionales viviendo solo en prompts
**Viola:** ADR-0002

*"Si el carrito está vacío, no inicies el checkout"* · *"No gestiones el pago vos"* · *"Confirmá antes de eliminar"* — todas en prosa, en un prompt de ~200 líneas, compitiendo por atención con instrucciones sobre emojis.

**Riesgo específico y fechado: el próximo upgrade de modelo re-tira los dados sobre todas estas reglas a la vez, sin aviso y sin test que lo detecte.** No falla en el deploy: falla la semana siguiente, en un caso raro, con dinero real.

**Corrección:** cada regla migra al borde de su Tool. El prompt conserva la **explicación**, nunca la aplicación.

---

### ~~V-06~~ · Reconciliador de pending del checkout — ✅ **CORREGIDA**
**Violaba:** ADR-0012 (prohibición de reconciliadores), ADR-0006 (FSM persistida)

Existía una función (`effectivePending`) que comparaba el flag de "paso pendiente" contra el estado real del pedido y lo limpiaba cuando descubría que el dato ya había sido provisto por otro camino.

**La función era correcta y arreglaba un bug real. Ese era exactamente el problema:** cristalizaba la duplicación en vez de eliminarla.

**Corrección (2026-07-12, Fase 1 del roadmap):** eliminada la fuente duplicada (V-08) — `src/services/checkout/effectivePending.ts` y su test fueron borrados. `resolveCheckoutPendingFromStep` (`checkoutGoal.service.ts`) deriva la misma información directamente de `nextCheckoutStep`. **El reconciliador desapareció solo**, porque no queda nada que reconciliar.

---

### ~~V-07~~ · La continuidad no está representada — ✅ **CORREGIDA**
**Violaba:** ninguna invariante — era el **hueco** que motivó toda la arquitectura

No existía `COMPLETAR_PEDIDO`. El estado del pedido se le inyectaba al modelo como un **número inerte** (*"carrito: 2 ítems"*), indistinguible de *"horario: 12–15h"*. El modelo no lo retomaba porque **nadie lo ponía en su función objetivo**.

**Corrección (2026-07-12, Fase 0 del roadmap):** `src/services/orderCompletionGoal.service.ts` — Goal derivado puro (`deriveOrderCompletionGoal`) sobre Facts ya existentes (ítems del carrito, sesión de checkout), sin persistencia propia. Ledger mínimo (`abandonment`, `surfaceCount`, `lastSurfacedAt`) en `conversation_state.metadata.intentLedger.COMPLETAR_PEDIDO`. Permiso calculado por el sistema (presupuesto 3, cooldown 10 min) e inyectado como línea en `[ESTADO DEL CLIENTE]` (`reactAgent.ts`) — el modelo decide cómo y si menciona el objetivo dentro de ese permiso, nunca si puede plantearlo. Tool `abandon_pending_order` (no borra el carrito) + revival automático en `add_cart_item`. Sin feature flag ni fase de shadow — decisión explícita del usuario dado que la rama no tiene tráfico real que medir (ver nota en `ROADMAP-MIGRACION.md`, Fase 0). Test: `src/services/__tests__/orderCompletionGoal.service.test.ts`.

---

### ~~V-15~~ · `COMPLETAR_RESERVA` no existe (continuidad de reservas no representada) — ✅ **CORREGIDA**
**Violaba:** ninguna invariante — era el gemelo de V-07 para el flujo de reservas.

`COMPLETAR_RESERVA` ya estaba en el catálogo cerrado (`TAXONOMIA.md` §2), pero ninguna fase del roadmap lo construía.

**Hallazgo durante la corrección:** a diferencia de V-07, esto **no** resultó ser solo exposición. `reservation_draft` vive dentro de la metadata de sesión (no en tabla propia como `draft_order`), y las cinco salidas del agente de reservas borraban `reservation_agent_active` y `reservation_draft` juntas, siempre — no existía un equivalente a `handback_to_main`. Sin eso, el Goal jamás podría haber estado abierto fuera de la sesión.

**Corrección (2026-07-12, Fase 1b del roadmap):** se construyó primero la pieza faltante — Tool `handback_reservation` (`src/tools/reservation.ts`), salida temporal que limpia `reservation_agent_active` pero conserva `reservation_draft`. Sobre esa base, `src/services/reservationCompletionGoal.service.ts` replica el patrón de `COMPLETAR_PEDIDO` (derivador puro + Ledger + permiso + revival). De paso se corrigió un bug latente: la escritura del Ledger pisaba entradas de otros Goals (`src/services/intentLedger.repository.ts` lo resuelve), y se agregó el arbitraje de saliencia (ADR-0009) que faltaba entre `COMPLETAR_PEDIDO` y `COMPLETAR_RESERVA` cuando ambos tienen permiso el mismo turno. Detalle completo en [`ROADMAP-MIGRACION.md`](ROADMAP-MIGRACION.md), Fase 1b. Test: `src/services/__tests__/reservationCompletionGoal.service.test.ts`.

---

### ~~V-16~~ · Doble mecanismo de confirmación de `remove_cart_item` — ✅ **CORREGIDA**
**Violaba:** ADR-0012 (duplicación de fuente de verdad) y, indirectamente, la intención de ADR-0002 — la confirmación seguía siendo real en ambos caminos por separado, pero **dos caminos que no se conocen entre sí** producen una UX rota, que es el mismo síntoma que motiva ADR-0012.

Encontrada por el usuario probando contra el bot real (no en este registro hasta ahora): al pedir eliminar un ítem en texto libre, el cliente recibía **dos confirmaciones distintas y desincronizadas** antes de que el ítem se borrara — un ida y vuelta confuso de 4 turnos en vez de 2.

**Causa raíz:** existían dos mecanismos de confirmación de eliminación que **no compartían estado**:
1. **Flujo determinístico preexistente** (`RemoveItemHandler` → `cart.service.ts`, intents `REMOVE_ITEM`/`CONFIRM_REMOVE`/`CANCEL_REMOVE`, ya en `CLOSED_INTENTS`): muestra botones, guarda `pendingAction: 'CONFIRM_REMOVE'` + `pendingItemId` en metadata, y borra directo con su propia transacción Prisma al tocar el botón — **nunca pasaba por la Tool**.
2. **El Constraint agregado en V-01** (`remove_cart_item`, Tool del agente híbrido): mantenía su propia clave separada, `pending_item_removal`.

Cuando el cliente respondía "sí" en texto libre en vez de tocar el botón, el clasificador de intents no siempre lo reconocía como `CONFIRM_REMOVE` (ese intent ni siquiera existe en el prompt del clasificador) y el turno caía al agente híbrido, que llamaba a la Tool — la cual, al no saber nada del pending ya mostrado por el flujo determinístico, volvía a preguntar por su cuenta. Ninguna de las dos rutas sabía que la otra ya había preguntado.

**Bug adicional encontrado en el camino:** la escritura del pending del flujo determinístico (`cart.service.ts`, antes de la corrección) usaba `updateConversationState(id, { metadata: {...} })`, que **reemplaza toda la columna `metadata`** en vez de mergear — mostrar el diálogo de confirmación de eliminación borraba de paso `checkout_active`, el `intentLedger` de los Goals, y cualquier otro estado de sesión concurrente.

**Corrección (2026-07-12):** unificadas ambas fuentes en una sola — `pendingAction`/`pendingItemId`/`pendingItemName`/`pendingActionAt` (nuevo, para el TTL), tipados en `ConversationMetadata`. La Tool `remove_cart_item` ahora lee y escribe exactamente esas claves (vía `patchConversationMetadata`, que sí mergea) en vez de su propio `pending_item_removal`. Cualquiera de los dos caminos que preguntó primero es evidencia válida para que el otro proceda. De paso, `cart.service.ts` dejó de pisar la metadata completa. Test: caso explícito de reproducción del bug real en `src/tools/__tests__/removeCartItem.test.ts`.

**Pendiente, fuera de este fix (menor, cosmético):** el clasificador de intents todavía no reconoce `CONFIRM_REMOVE`/`CANCEL_REMOVE` como categorías propias, así que un "sí" en texto libre a veces sigue re-disparando la UI determinística de confirmación (ya no pregunta dos veces con mensajes distintos, pero puede re-mostrar el mismo botón una vez de más). No es un problema de seguridad ni de arquitectura — es una mejora de calidad de clasificación para una fase futura.

---

### ~~V-17~~ · El checkout no informa costo real de envío ni descuentos por método de pago — ✅ **CORREGIDA**
**Viola:** ninguna invariante — es un hueco de UX/producto encontrado probando contra el bot real, no una violación del modelo conceptual.

Al preguntar "¿cuánto cuesta el delivery?" o "¿hay descuento con efectivo?" durante el checkout, el bot respondía con una frase genérica ("se calcula al finalizar el pedido... podés ver los detalles en el proceso de pago") en vez de un número real, incluso cuando el dato ya estaba disponible.

**Causa raíz, dos partes distintas:**
1. **Descuento por método de pago:** `get_cart` (llamada obligatoria en cada turno del checkout, "TOOL-FIRST") ya devolvía `paymentOptions` con el ajuste real configurado — pero el prompt del checkout ordenaba delegar *cualquier* pregunta de precios/descuentos al asistente principal sin usar el dato que ya tenía en mano. El asistente principal, delegado, tampoco lo usaba de forma consistente.
2. **Costo de envío:** `get_cart` nunca calculaba el costo real — devolvía siempre una nota fija ("se agrega al confirmar según tu zona"), **incluso con la dirección ya guardada y en cobertura**, a pesar de que `resolveDeliveryContext` (`services/deliveryFee.service.ts`) ya existe y se usa para cobrar de verdad al crear la orden (no es un bug de plata: el monto correcto sí se cobraba al final, solo no se comunicaba antes).

**Corrección (2026-07-12):** `get_cart` (`src/tools/index.ts`) ahora llama `resolveDeliveryContext` y expone `pricing.deliveryFee` + `pricing.total` con el número real cuando ya hay dirección en cobertura (distingue "todavía no se sabe" de "la zona cobra $0", vía `zoneId !== null`); si no es resoluble todavía, `pricing.note` sugiere invitar al cliente a compartir la dirección en vez de una frase vacía. Prompts de checkout e híbrido (`src/prompts/botPersonality.ts`) actualizados para responder con estos números directamente en vez de derivar la pregunta — se agregó una excepción explícita a la regla de "no respondas inline sobre precios" del checkout, acotada a estos dos casos donde el dato ya está en el tool call obligatorio del turno. Test: `src/tools/__tests__/getCart.test.ts`.

**Bug de continuación encontrado el mismo día, mismo síntoma:** el fix inicial pasaba `fulfillmentType: draft.fulfillment_type` a `resolveDeliveryContext`, que exige `'DELIVERY'` para resolver — antes de que el cliente tocara el botón de delivery, ese campo era `null`, así que la pregunta "¿cuánto sale el envío?" seguía respondiendo "necesito tu dirección" **aunque el cliente ya la tuviera guardada** de una compra anterior (se pudo confirmar porque el checkout, más adelante, saltó directo de "elegí delivery" a "elegí cómo pagar" sin pedir dirección — prueba de que sí existía). Corregido: `get_cart` ahora consulta con `fulfillmentType: 'DELIVERY'` como hipótesis siempre que el cliente no haya elegido explícitamente `TAKE_AWAY`, no solo cuando ya lo eligió.

**Pendiente, fuera de este fix (mejora de UX, no bug):** al agregar un ítem al carrito no hay ningún aviso proactivo de que el envío depende de la dirección (solo se informa si el cliente pregunta). Sugerencia del usuario, no implementada todavía — no aplica si el negocio no tiene delivery o el cliente ya eligió retiro en local.

---

### ~~V-18~~ · Elegir método de pago disparaba el cobro sin revisión final del total — ✅ **CORREGIDA**
**Viola:** ADR-0002 en espíritu — no había ningún Constraint (ni en el prompt, ni en el borde de la Tool) que impidiera crear la orden y procesar el pago sin que el cliente hubiera visto el total final.

Encontrada por el usuario probando el checkout contra el bot real: en el momento en que el cliente tocaba "💵 Efectivo" (o decía "efectivo" en texto libre), el sistema creaba la orden **inmediatamente** — sin mostrar antes el total real (envío + ajuste de pago incluidos). El monto se calculaba y cobraba correctamente en ese momento (no era un bug de plata, verificado contra `checkout.service.ts`), pero el cliente no tenía forma de arrepentirse si el envío resultaba más caro de lo esperado: para cuando veía el total, el pedido ya estaba confirmado.

**Decisión de diseño (con el usuario):** elegir el método de pago pasa a ser un paso intermedio, no una acción que ejecuta. Se agrega un paso nuevo — `confirm` en `nextCheckoutStep` / Goal `CONFIRMAR_PEDIDO` en el catálogo (`TAXONOMIA.md` §2) — entre "elegir método" y "crear la orden", con botones ✅ Confirmar / ❌ Cancelar y soporte de confirmación en texto libre (mismo patrón que la confirmación de `remove_cart_item`, V-01/V-16).

**Corrección (2026-07-12):**
- `nextCheckoutStep` (`services/checkout/nextCheckoutStep.ts`): nuevo paso `'confirm'` — se deriva solo de que `paymentMethod` ya esté elegido (Fact) mientras la sesión sigue activa; no hace falta un flag nuevo.
- `services/checkout/orderConfirmationMessage.ts` (nuevo): arma el resumen final reusando el mismo cálculo de precio que cobra de verdad (`computeOrderPricing`, `resolveDeliveryContext`, `resolvePaymentAdjustment`) — un solo cálculo, no una copia que pueda desincronizarse del monto real.
- Tool `resolve_order_confirmation` (`tools/checkout.ts`) — señal para que el nodo ejecute o descarte el pago; nunca cobra por sí misma (ADR-0004). El nodo (`graph/nodes/checkout/index.ts`) es quien decide: `confirmed: true` → ejecuta el pago (mismo `PayCashHandler`/`PayOnlineHandler` de antes) y recién ahí crea la orden; `confirmed: false` → revierte `payment_method` a `null` (`clearDraftPaymentMethod`) y vuelve a mostrar las opciones de pago — `nextCheckoutStep` vuelve solo al paso `payment`, sin flag de cancelación aparte.
- Soporta confirmación por botón (`CONFIRM_ORDER`/`EDIT_PAYMENT_METHOD`, deterministic en el nodo) y por texto libre (vía el mismo pipeline de `[EXTRACCIÓN PASO PENDIENTE]` + `extractPendingTurnResponse` que ya usan fulfillment/payment — se registró `confirm_order` en `pendingActionRegistry.ts`).
- Prompt del checkout actualizado: nuevo paso 5 "CONFIRMACIÓN FINAL", instruido para no redactar el resumen ni el total (son datos del sistema).

Tests: `nextCheckoutStep.test.ts`, `orderConfirmationMessage.test.ts`, casos nuevos en `checkoutGoal.service.test.ts` y `pendingActionRegistry.test.ts`.

---

### ~~V-19~~ · Onboarding: confirmación de dirección duplicada y contradictoria — ✅ **CORREGIDA**
**Viola:** ADR-0002 en espíritu — la regla "no describas la dirección ni pidas confirmación en texto" solo existía en el prompt, nada la obligaba.

Encontrada probando el flujo de captura de dirección (onboarding) contra el bot real: al confirmar una dirección en texto libre, el bot mandaba **dos mensajes contradictorios en el mismo turno** — uno de texto libre del LLM ("Dirección confirmada... ¿seguimos con el pedido?") dando el trámite por cerrado, y otro, aparte, con los botones "¿Es correcta?" preguntando lo mismo que el primero ya daba por resuelto.

**Causa raíz:** en `graph/nodes/onboarding/index.ts`, cuando el agente señalaba `present_address_confirmation`, el nodo armaba la respuesta como `content: text` (texto libre del LLM) **+** `followUps: [botones]` — el mismo patrón que ya habíamos corregido en checkout para `present_fulfillment_options`/`present_payment_options` (Tarea 4.1), pero que en onboarding nunca se había tocado. El LLM ignoró la instrucción del prompt y el sistema no tenía nada que lo obligara.

**Corrección (2026-07-12):** igual que en checkout — el texto libre del LLM se descarta cuando hay una confirmación de dirección staged; el nodo manda **un solo mensaje determinístico** (la dirección + botones Confirmar/Editar), sin followUp aparte.

---

### ~~V-20~~ · Onboarding: preguntas laterales (precio/envío) no se delegaban — ✅ **CORREGIDA**
**Viola:** ninguna invariante — hueco de continuidad, mismo tipo de hallazgo que V-17.

En el mismo flujo, preguntar "¿cuánto sale el delivery?" mientras se esperaba la confirmación de dirección no se contestaba — el bot repetía la confirmación de dirección, ignorando la pregunta. A diferencia del checkout, el onboarding no tenía ningún mecanismo para distinguir "el cliente está respondiendo la confirmación" de "el cliente preguntó otra cosa": todo mensaje libre iba directo al agente ReAct general, cuya única guía era una regla de prompt no muy específica.

**Corrección (2026-07-12):** se construyó para onboarding el mismo mecanismo de PASO PENDIENTE que ya tiene el checkout — un llamado LLM dedicado y acotado (`extractPendingTurnResponse`, reusado tal cual, **sin agregar regex**: la clasificación fulfilled/reprompt/delegate la resuelve el mismo clasificador LLM que ya usa checkout) que decide si el mensaje confirma/edita la dirección o es una pregunta lateral a delegar. Nueva tool `resolve_address_confirmation` (`tools/onboarding.ts`) — señal, nunca guarda por sí misma (ADR-0004); el guardado real pasa por un nuevo método público `AddressService.resolveStagedAddressConfirmation`, que reusa exactamente la misma lógica que ya usaban los botones `ONBOARDING_CONFIRM_ADDRESS`/`ONBOARDING_EDIT_ADDRESS` — una sola fuente de verdad para "qué pasa al confirmar", sin importar el canal (botón o texto libre).

**Nota de proceso:** el primer intento de este fix usó regex para detectar "cambio de tema" (igual patrón que ya tenía `extractPendingTurnResponse` para fulfillment/payment) — se revirtió por señalamiento explícito del usuario: un sistema con clientes de distintas nacionalidades no puede depender de listas de palabras clave en español para detectar intención. Todo lo que requiera interpretar significado pasa por el clasificador LLM existente, nunca por regex nuevo.

---

### ~~V-21~~ · `isInCoverage` con fallback legacy admitía direcciones sin zona real — ✅ **CORREGIDA**
**Viola:** el Constraint "No delivery sin dirección en cobertura" (`TAXONOMIA.md` §7).

`context/index.ts` consideraba una dirección "en cobertura" no solo cuando había una zona real asignada, sino también cuando la dirección **nunca tuvo** `delivery_zone_id` asignado (`zone !== null || defaultAddress.delivery_zone_id === null`) — un fallback de compatibilidad con registros viejos. Esto dejaba avanzar el checkout más allá del paso de dirección con una dirección que `resolveDeliveryContext`/`get_cart` **no podía cotizar** (exigen `zoneId !== null` para dar un número real), mostrando "sin envío" en el resumen final y un mensaje genérico de "no hay dirección" al preguntar el costo — aunque el checkout ya la había dado por resuelta.

**Corrección (2026-07-13):** eliminado el fallback en ambas ramas de `context/index.ts` (la de checkout y la general) — `isInCoverage` exige siempre `zone !== null`. Decisión explícita del usuario: sin excepción de compatibilidad.

---

### ~~V-22~~ · Sin tool para consultar/cambiar dirección o cobertura fuera de una sesión activa — ✅ **CORREGIDA**
**Viola:** ninguna invariante — hueco de UX/producto, mismo tipo de hallazgo que V-17.

Preguntas como "¿hacen delivery a mi dirección?", "¿cuál dirección tienen guardada?" o "quiero cambiar mi dirección" **antes** de tener un carrito activo no tenían ningún tool que las resolviera: `get_cart` (la única fuente de datos de envío) cortaba con `{exists:false}` sin dirección propia si no había `draft_order` — nunca llegaba a mirar la dirección default del cliente. El híbrido tampoco tenía forma de guardar una dirección nueva compartida en este contexto.

**Corrección (2026-07-13):** tool nueva `check_delivery_coverage()` (`tools/index.ts`) — resuelve dirección guardada + cobertura + costo real vía `resolveDeliveryContext`, independiente de si hay carrito. Tool `stage_delivery_address(addressText)` para que el híbrido pueda geocodificar y dejar pendiente de confirmación una dirección nueva compartida en cualquier momento (ver V-24 para el mecanismo de confirmación). Prompt ampliado para cubrir consultas de "cuál tengo guardada" y pedidos de cambio de dirección, no solo preguntas de costo/cobertura.

---

### ~~V-23~~ · Onboarding secuestraba el turno del híbrido tras guardar la dirección — ✅ **CORREGIDA**
**Viola:** ADR-0001 (Ownership) — el híbrido es el único agente que compone respuestas generales/"qué sigue"; ningún agente de dominio debe hacerlo por su cuenta.

Al guardar la dirección (fuera del caso de continuar un checkout activo), `AddressService.saveAddress()` llamaba directo a `buildSmallTalkMenu()` — un menú de bienvenida genérico ("¿En qué puedo ayudarte hoy?") — en vez de cederle el turno al híbrido. Encontrado probando: un cliente con productos ya en el carrito, al confirmar su dirección, recibía un saludo de bienvenida completo en vez de que se le ofreciera continuar el pedido — el sistema no distinguía a alguien que recién resolvió un dato pendiente de un visitante nuevo. El motor de Goal `COMPLETAR_PEDIDO` (V-07) ya existe y ya sabe ofrecer continuar el pedido con presupuesto anti-insistencia — nunca se ejecutaba porque el turno no llegaba al híbrido.

**Corrección (2026-07-13):** `saveAddress()` acepta `skipSmallTalkMenu` — el flujo ReAct (`resolveStagedAddressConfirmation`) lo pasa y devuelve solo un ack corto. `onboardingAgentNode` y el nuevo `delegatedAddressConfirmationNode` (V-24) invocan al híbrido inline tras guardar (mismo patrón ya usado para `finish_onboarding`), dejando que `COMPLETAR_PEDIDO` decida si corresponde ofrecer continuar. El wizard legacy (`.confirm()`/`.process()`, ya `@deprecated`) sigue usando `buildSmallTalkMenu` sin cambios — no se tocó, está fuera de alcance de eliminación en esta sesión.

---

### ~~V-24~~ · Confirmación de dirección: botones no garantizados estructuralmente — ✅ **CORREGIDA**
**Viola:** ADR-0002 — mismo patrón que V-19, encontrado de nuevo en un punto distinto del flujo.

Dos hallazgos relacionados, probando contra el bot real:
1. El LLM de onboarding a veces respondía su propia pregunta de confirmación en texto libre sin llamar la tool `present_address_confirmation` — la respuesta salía sin botones (`isInteractive: false`), dejando al cliente sin forma de confirmar por botón.
2. El intercept determinístico del botón "Confirmar" (`ONBOARDING_CONFIRM_ADDRESS`, en `onboardingAgentNode`) llamaba a `addressService.process()` — el método **legacy**, que no pasa `skipSmallTalkMenu` — mostrando el mismo saludo de bienvenida de V-23 también al confirmar por botón, no solo por texto libre.

**Corrección (2026-07-13):** se eliminó la tool `present_address_confirmation` del lado de onboarding (quedó solo para el híbrido, ver V-22) — la garantía de botones ya no depende de que el LLM la llame: el nodo adjunta los botones directamente al texto propio del LLM (sin reemplazarlo por una frase enlatada — decisión explícita del usuario, dado que el texto del LLM en este punto no afirma cierre, solo pregunta) cuando detecta una dirección staged sin confirmar, releyendo el estado **fresco** post-tool-call (la lectura vieja causaba un retraso de un turno). El intercept del botón ahora usa `resolveStagedAddressConfirmation` — la misma función que el camino de texto libre — en vez del método legacy. Se construyó además el mecanismo equivalente para el híbrido (`delegatedAddressConfirmationNode`, nuevo nodo con prioridad de ruteo en `context/index.ts` sobre cualquier otra sesión) para direcciones compartidas fuera de onboarding/checkout (V-22).

---

### ~~V-25~~ · Checkout: botones de fulfillment/pago/confirmación no garantizados sin señal del LLM — ✅ **CORREGIDA**
**Viola:** ADR-0002 — mismo patrón que V-24, en el checkout.

Encontrado probando con usuarios reales: el mensaje "¿Cómo querés pagar?" salía en texto plano, sin los botones de método de pago. Causa raíz: `checkoutResponsePolicy.ts` reemplaza el texto del LLM por un mensaje de continuación determinístico cuando no hubo ninguna tool reconocida en el turno (protección correcta contra afirmaciones de cierre sin evidencia) — pero ese reemplazo era solo de texto, nunca forzaba los botones correspondientes. El mismo hueco existía en el paso `confirm` (resumen final antes de cobrar): sin señal, el fallback mostraba un texto genérico ("seguimos con tu pedido") en vez de la tarjeta con el total real y los botones Confirmar/Cancelar.

**Corrección (2026-07-13):** en `checkout/index.ts`, los botones de fulfillment/pago se adjuntan según el estado real (`currentStep`), no solo según si el LLM llamó `present_fulfillment_options`/`present_payment_options`. Para el paso `confirm`, se reconstruye la tarjeta real (`buildOrderConfirmationMessage`) con el texto del LLM como `leadingText` cuando no hubo señal de confirmación ese turno.

---

### ~~V-26~~ · `MODIFY_QUANTITY` siempre aditivo (sin cantidad absoluta ni decremento parcial) — ✅ **CORREGIDA**
**Viola:** ninguna invariante — hueco de producto encontrado probando con usuarios reales.

Un cliente con 10 unidades de un producto pidió "quiero solamente 1 de X" — el sistema lo sumó a las 10 en vez de fijar la cantidad en 1. Causa raíz: tanto `add_cart_item` (tool del híbrido) como `ModifyQuantityHandler`/`handleAddItemFromWebhook` (el handler determinístico al que `MODIFY_QUANTITY`/`ADD_ITEM` quedan atados siempre — están en `CLOSED_INTENTS`, nunca llegan al híbrido) usaban la misma semántica aditiva (`newQty = existing.quantity + qty`) sin excepción. Un segundo caso relacionado, "quita 1" (decremento relativo), tampoco tenía ningún camino correcto: ni `MODIFY_QUANTITY` (ejemplos del clasificador eran solo absolutos, "cambiá a 3") ni `REMOVE_ITEM` (elimina el ítem completo) lo cubrían.

**Corrección (2026-07-13, con el usuario — decisión explícita de arreglarlo en el handler determinístico, no moviendo el intent al híbrido):** `buildAddItemMessage`/`handleAddItemFromWebhook` (`cart.service.ts`) aceptan `mode: 'add' | 'set'`. El clasificador de intención (`intentDetection.ts`) ahora distingue `quantityMode: 'absolute' | 'decrease'` para `MODIFY_QUANTITY`, propagado vía `IntentDetectionResult` → `IntentClassification`. `ModifyQuantityHandler`: modo absoluto usa `mode: 'set'`; modo decremento lee la cantidad actual, calcula el objetivo y, si el resultado es ≤ 0, remueve el ítem completo (reusa `executeRemoveDraftOrderItemFromWebhook`) en vez de dejar una fila en cantidad 0.

---

### ~~V-27~~ · `TRACK_ORDER` era un intent muerto (ni clasificado ni con handler) — ✅ **CORREGIDA**
**Viola:** ninguna invariante — hueco de producto.

El intent `TRACK_ORDER` existía en el catálogo de `ConversationIntent` y en `CLOSED_INTENTS`, pero **no estaba en la lista de intents que conoce el clasificador** (`intentDetection.ts`) — el LLM nunca lo generaba — y aunque lo generara, no había ningún `IntentHandler` registrado que lo atendiera. Un cliente preguntando "¿cómo va mi pedido?" (después de haber pagado) no tenía ninguna respuesta útil posible.

**Corrección (2026-07-13):** tool nueva `get_order_status()` (híbrido) — devuelve **todos** los pedidos del cliente en curso (puede tener varios el mismo día), no solo el último; cada uno numerado por posición (`index: 1, 2, 3...`, del más viejo al más nuevo) para que el bot los nombre como "pedido 1", "pedido 2" sin inventar otra numeración. Reusa `ORDER_STATUS_LABEL_ES`/`ORDER_PAYMENT_STATUS_LABEL_ES` (ya existentes para notificaciones push de admin). `TRACK_ORDER` agregado al clasificador con ejemplos y sacado de `CLOSED_INTENTS` para que llegue al híbrido.

**Ajuste de filtro (2026-07-14):** el primer filtro solo excluía `delivered` (`status !== delivered`) — mostraba de más: pedidos `cancelled` (cerrados, nada que rastrear) y `draft` (vestigial, los pedidos se crean directo en `placed`). Corregido a lista blanca explícita — `status: { in: [placed, preparing, shipped, ready_for_pickup] }` — solo pedidos genuinamente en curso.

---

## P2 — Deuda estructural

### ~~V-08~~ · Pending del checkout persistido — ✅ **CORREGIDA**
**Violaba:** ADR-0006 (la FSM vive en una función, nunca en una fila)

El sistema tenía **la solución correcta ya implementada** —una función pura que deriva el paso del checkout desde los Facts (`nextCheckoutStep`)— **y también** el flag persistido que hacía lo mismo (`checkout_pending_action`/`checkout_pending_question`), **más** el reconciliador que los mantenía en línea (V-06). **Tenía las dos, y por eso tenía el bug.**

**Corrección (2026-07-12, Fase 1 del roadmap):** eliminado el flag — sacado de `ConversationMetadata`, ya no se escribe en ningún lugar (`checkoutAgent.ts`, `graph/nodes/checkout/index.ts`, `tools/checkout.ts`). La función se quedó. Con eso cayeron V-06 y V-08 juntas, como estaba previsto.

---

### V-09 · `awaiting_address` fusiona tres categorías
**Viola:** ADR-0001

Un solo nombre para tres cosas distintas: el Ownership de captura por texto, el Goal `OBTENER_DIRECCION` y la Opportunity `SUGERIR_DIRECCION`. Ver [`TAXONOMIA.md §6`](TAXONOMIA.md).

**Es el ejemplo canónico de "un concepto que se resiste a ser clasificado".** Y como toda fusión de Ownership con Intent, hereda lo peor de ambos: bloquea como Ownership y persiste como Intent.

---

### V-10 · Presupuesto de insistencia en 6 encarnaciones
**Viola:** ADR-0007

Contadores de rechazo (×2), banners ya mostrados, cooldowns de sugerencias (×3). **Seis implementaciones del mismo concepto: "¿cuántas veces ya lo dije?"** — cada una con su nombre, su formato y su limpieza.

**Corrección:** una sola política, en el Ledger.

---

### V-11 · Limpieza dispersa de un Intent declarado
**Viola:** ADR-0005

El Intent de tarea interrumpida se limpia **a mano en ~7 lugares distintos**. Es el síntoma diagnóstico del pending action infinito: *cuando el mismo campo se limpia en cinco lugares, no tenés un flag — tenés un Intent que nadie modeló, y estás implementando su ciclo de vida a mano, disperso, sin dueño.*

**Corrección:** una política de TTL, en el Ledger.

---

### V-28 · Sin empuje proactivo hacia armar pedido/reserva (más allá del primer saludo)
**Viola:** ninguna invariante — hueco de producto, identificado explícitamente por el usuario como **el objetivo primario del bot**: "empujar a armar una reserva o pedido... es el objetivo primario del bot en realidad".

El sistema ya tiene un motor de Goal maduro para **continuar** algo empezado (`COMPLETAR_PEDIDO`/`COMPLETAR_RESERVA`, con presupuesto anti-insistencia y cooldown), pero nada empuja a **iniciar** un pedido o reserva desde cero. Se identificaron dos casos:
1. **Primer saludo:** el prompt del híbrido prohibía explícitamente mostrar menú/lista en el saludo inicial, dejando una pregunta abierta genérica ("¿en qué te ayudo?") en vez de ofrecer concretamente ver el menú o reservar. **Corregido (2026-07-13):** tool `present_welcome_options(bodyText)` + botones (incluye "Reservar mesa" si `reservations_enabled`) — ver prompt `SALUDOS Y CHARLA CASUAL`.
2. **Reservas, de forma proactiva:** a diferencia de `COMPLETAR_PEDIDO` (que se abre gratis con `hasItems`), no hay ningún mecanismo que sugiera reservar sin que el cliente lo pida primero — depende 100% de que mencione "reservar"/"mesa" explícitamente. **Sin corregir** — requiere diseño de un Goal/Opportunity nuevo, discutido pero no construido en esta sesión.

**Pendiente:** diseñar el empuje más allá del primer saludo (¿tras N turnos sin rumbo? ¿Opportunity con presupuesto 1, o Goal con iniciativa del sistema en vez del cliente — necesita definirse contra la Taxonomía, ADR-0008, antes de codear).

---

## P3 — Limpieza

### V-12 · TTL de oferta que nunca se lee
El timestamp de la oferta se guarda; **nadie lo consume**. Una oferta de hace cuarenta minutos sigue viva. Es un TTL que alguien pensó y no llegó a implementar.

### V-13 · ~36 flags en el estado de conversación
La acumulación que esta arquitectura existe para revertir. **Meta: ≤ 9.** Se resuelve como consecuencia de las demás, no como tarea propia.

### V-14 · Wizard legacy de reservas
Ya marcado obsoleto. **Es la causa raíz de V-03.** Eliminarlo cierra la violación de la Invariante 1 de forma definitiva.

---

## Métricas de salud

Tres números, sin ambigüedad, medibles hoy:

| Métrica | Hoy | Meta |
|---|:-:|:-:|
| **Reconciliadores en el código** | 0 (era 1) | **0** ✅ |
| **Flags en el estado de conversación** | ~34 (era ~36; V-01 no quitó flag, Fase 1 quitó 2: `checkout_pending_action`/`checkout_pending_question`) | **≤ 9** |
| **Reglas transaccionales que existen únicamente en prompts** | ≥ 4 | **0** |

**Regla:** ningún PR puede empeorar estas tres métricas sin un ADR que lo justifique.

---

## Historial de correcciones

| Fecha | Violación | Nota |
|---|---|---|
| 2026-07-11 | **V-04** | Marcada como ya corregida al verificarla contra el código. Había sido registrada a partir de un documento de bug obsoleto, no del estado real del worker. |
| 2026-07-11 | **V-03** | Ídem: el guard `reservationBlocksRouting` ya estaba implementado. Queda la causa raíz (V-14), no el síntoma. |
| 2026-07-12 | **V-06, V-08** | Corregidas juntas (Fase 1 del roadmap): flag de pending del checkout eliminado, el reconciliador desapareció solo. Ver detalle en P1/P2. |
| 2026-07-12 | **V-15** | Corregida (Fase 1b): requirió construir `handback_reservation` primero (no existía forma de salir de la sesión de reservas sin borrar el borrador). De paso se corrigió un bug de escritura del Ledger y se agregó el arbitraje de saliencia entre Goals que faltaba. |
| 2026-07-11 | **V-01** | Corregida: Constraint de confirmación en el borde de `remove_cart_item`, vía pending persistido en `conversation_state.metadata` con TTL. Ver detalle en P0. |
| 2026-07-11 | **V-02** | Corregida: nodo `escalationGateNode` determinista antes del routing, sin excepción de sesión. Ver detalle en P0. |
| 2026-07-12 | **V-07** | Corregida: primer Goal derivado del sistema, `COMPLETAR_PEDIDO` (Fase 0 del roadmap). Sin shadow — ver nota en `ROADMAP-MIGRACION.md`. |
| 2026-07-12 | **V-16** | Encontrada probando contra el bot real (doble confirmación al eliminar un ítem) y corregida el mismo día: unificado el pending de `remove_cart_item` con el del flujo determinístico preexistente, más un bug de sobreescritura de metadata de paso. Ver detalle en P1. |
| 2026-07-12 | **V-17** | Encontrada probando el checkout contra el bot real (respuestas genéricas sobre costo de envío y descuentos): `get_cart` no exponía datos que ya tenía o podía calcular. Corregida el mismo día, con un segundo fix el mismo día para el caso "pregunta antes de elegir delivery". Ver detalle en P1. |
| 2026-07-12 | **V-18** | Encontrada probando el checkout contra el bot real (el pago se procesaba al elegir método, sin revisión final del total). Corregida el mismo día: nuevo paso `confirm` en el checkout con botones y soporte de texto libre. Ver detalle en P1. |
| 2026-07-12 | **V-19, V-20** | Encontradas probando el flujo de onboarding (captura de dirección) contra el bot real: mensajes de confirmación duplicados/contradictorios y preguntas laterales ignoradas. Corregidas el mismo día, reusando el patrón de PASO PENDIENTE del checkout — sin regex, todo vía el clasificador LLM existente. Ver detalle en P1. |
| 2026-07-13 | **V-21** | Encontrada revisando el código al investigar un bug de dirección reportado por el usuario: fallback legacy dejaba avanzar el checkout con direcciones sin zona real. Corregida el mismo día — sin excepción de compatibilidad, decisión explícita del usuario. |
| 2026-07-13 | **V-22, V-23, V-24** | Cadena de hallazgos de una misma sesión de pruebas con usuarios reales sobre el flujo de dirección: preguntas de cobertura sin tool (V-22), onboarding secuestrando el turno del híbrido al guardar la dirección (V-23), y botones de confirmación no garantizados por dos caminos distintos — texto libre y botón (V-24). Corregidas juntas el mismo día, construyendo `check_delivery_coverage`/`stage_delivery_address`/`delegatedAddressConfirmationNode` como mecanismo nuevo para direcciones fuera de sesión, y unificando el guardado de onboarding en una sola función sin importar el canal. |
| 2026-07-13 | **V-25** | Encontrada probando el checkout con usuarios reales (botones de pago faltantes). Mismo patrón que V-24 aplicado al checkout — corregida el mismo día, extendida también al paso `confirm` antes de cerrar. |
| 2026-07-13 | **V-26** | Encontrada probando con usuarios reales (cantidad de ítems tratada siempre como aditiva). Corregida el mismo día, con una segunda iteración para el caso de decremento relativo ("quita 1") tras una segunda ronda de pruebas del usuario. |
| 2026-07-13 | **V-27** | Encontrada al investigar la tool de seguimiento de pedido pedida por el usuario: `TRACK_ORDER` era intent muerto. Corregida el mismo día; ampliada después para soportar múltiples pedidos activos simultáneos (no solo el último) tras aclaración del usuario. |

> **Lección, y por qué esta tabla existe:** V-03 y V-04 entraron al registro copiadas de documentos de auditoría **que describían el sistema de hace tres semanas**. Ambas ya estaban arregladas. **Toda violación se verifica contra el código antes de entrar acá — un doc de bug no es evidencia, es historia.** Es, literalmente, el anti-patrón de la duplicación de fuentes de verdad (§12.5) aplicado a la documentación.
