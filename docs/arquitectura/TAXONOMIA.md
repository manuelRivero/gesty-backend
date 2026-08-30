# Taxonomía oficial de entidades

**Estado:** normativo. Complementa [`ARQUITECTURA.md`](../../ARQUITECTURA.md).
**Naturaleza:** catálogo **cerrado** (ADR-0011). Agregar una entidad es un cambio de código revisado, nunca una decisión de runtime.

**Cómo se agrega una entidad:** PR que (a) la agrega a este documento, (b) declara su categoría y sus propiedades, (c) pasa el checklist de clasificación de §7. **Si no puede clasificarse en una sola categoría, está mal nombrada y esconde dos cosas adentro** — no se agrega hasta separarla.

---

## 1. FACTS

Verificables, fuente única, sin opinión. Viven en tablas del negocio, **nunca** en el estado de conversación.

| Fact | Fuente | Notas |
|---|---|---|
| `PEDIDO_EN_CURSO` | `draft_order` | Existe, tiene ítems, no está confirmado |
| `ITEMS_DEL_PEDIDO` | `draft_order_item` | Producto, cantidad, nota |
| `TOTAL_DEL_PEDIDO` | `draft_order` | **Derivado. Nunca copiar.** |
| `TIPO_DE_ENTREGA` | `draft_order` | `DELIVERY` \| `TAKE_AWAY` \| ausente |
| `METODO_DE_PAGO` | `draft_order` | `cash` \| `online` \| ausente |
| `ORDEN_CONFIRMADA` | `order` | |
| `PAGO_ACREDITADO` | `payment` | |
| `DIRECCION_DEL_CLIENTE` | `customer_address` | |
| `COBERTURA_DE_LA_DIRECCION` | `delivery_zone` ∩ dirección | **Se revalida en cada turno**: las zonas cambian |
| `NOMBRE_DEL_CLIENTE` | `customer` | |
| `CATALOGO` | `menu_item`, `category` | Nombres, precios, descuentos, disponibilidad |
| `HORARIO_DEL_NEGOCIO` | `business`, config | Incluye `operate_when_closed` |
| `RESERVA_EN_CURSO` | borrador de reserva | Fecha, slot, personas, ambiente |
| `RESERVA_CONFIRMADA` | `reservation` | |
| `PERSONAS_DEL_PEDIDO` | estado de sesión | Cuántos van a comer |
| `PRODUCTO_EN_FOCO` | estado de sesión | Último producto referenciado |
| `HISTORIAL_DE_MENSAJES` | `conversation_message` | |
| `SENTIMIENTO_DE_LA_CONVERSACION` | `conversation.ai_sentiment` | Proxy de “queja” para el owner assistant: `FRUSTRATED` / `NEEDS_HUMAN` |

**Prohibido en Facts:** intenciones · historial del comportamiento del bot · control de flujo · cualquier valor regenerable.

---

## 2. GOALS

Intención **obligatoria**. Iniciativa del **cliente**. Si nunca se cumple, **el cliente quería algo y no lo obtuvo**.
Presupuesto: **3 → enmudece, no muere.** Cierre: **cambio en un Fact.**

### Derivados (proyección pura — no se persisten)

| Goal | Se deriva de | Presión | Se cierra cuando |
|---|---|---|---|
| `COMPLETAR_PEDIDO` | pedido con ítems, sin orden confirmada | reanudable | se confirma la orden, o el carrito queda vacío |
| `DEFINIR_ENTREGA` | pedido sin tipo de entrega | bloqueante | aparece el tipo de entrega |
| `OBTENER_DIRECCION` | entrega = DELIVERY, sin dirección en cobertura | bloqueante | aparece dirección válida |
| `OBTENER_NOMBRE` | checkout en curso, cliente sin nombre | bloqueante | aparece el nombre |
| `DEFINIR_METODO_DE_PAGO` | pedido sin método de pago | bloqueante | aparece el método |
| `CONFIRMAR_PEDIDO` | método de pago elegido, orden todavía no creada | bloqueante | el cliente confirma o cancela el resumen final |
| `CONFIRMAR_PAGO_ONLINE` | link emitido, pago sin acreditar | reanudable | se acredita el pago |
| `RESOLVER_COBERTURA` | dirección cargada fuera de zona | bloqueante | dirección en cobertura |
| `COMPLETAR_RESERVA` | borrador de reserva incompleto | reanudable | se confirma la reserva |
| `CONFIRMAR_ELIMINACION` | eliminación solicitada sin confirmar | bloqueante | se confirma o se descarta |
| `DESBLOQUEAR_PEDIDO_CERRADO` | ítem pendiente por negocio cerrado | reanudable | el negocio abre, o el cliente desiste |
| `OBTENER_PERSONAS_DEL_PEDIDO` | Fact `PERSONAS_DEL_PEDIDO` ausente **y** señal de comida (turno o sesión: shortlist, last offer/CTA, o intent comida Fase A) | **bloqueante** | aparece `PERSONAS_DEL_PEDIDO` (`peopleCount` / `requestedPartySize`) |

> ⚠️ **Party size no es Opportunity ni Ownership.** Sin personas no hay recomendaciones/porciones útiles: es Goal blocking del flujo de comida. El tipable (“3”, “somos cuatro”) lo interpreta el ReAct vía `save_party_size` — **no** un flag `awaitingPartySize` que rutee fuera del agente (mismo anti-patrón que `awaiting_address`, §6). Alias histórico de catálogo: `RECOLECTAR_PARTY_SIZE` (solo migración de ledger).

> ⚠️ **El orden entre los goals de checkout NO es una prioridad de Goals.** Lo determina la función de orden del flujo, que es un **Constraint** (ADR-0006). El ranker delega el desempate; **no sabe —ni debe saber— que la dirección va antes que el pago.** Con comida y sin personas, `OBTENER_PERSONAS_DEL_PEDIDO` (blocking) gana a `COMPLETAR_PEDIDO` (resumable) por saliencia.

### Declarados (persistidos — solo lo inderivable)

| Goal | Por qué no se deriva | TTL |
|---|---|---|
| `RETOMAR_TAREA_INTERRUMPIDA` | El texto original del cliente al ser interrumpido es historia conversacional; no existe en ninguna tabla | sesión |
| `RESPONDER_CONSULTA_PENDIENTE` | El bot prometió averiguar algo. No hay Fact que lo represente | 24 h |
| `DESAMBIGUAR_PRODUCTO` | La ambigüedad nació en la conversación, no en el catálogo | 3 turnos |

---

## 3. OPPORTUNITIES

Intención **opcional**. Iniciativa del **negocio**. Si nunca se cumple, **no pasa nada**.
Presupuesto típico: **1 → se abandona.** Cierre: **decay** o un Fact.

| Opportunity | Se deriva de / nace de | Notas |
|---|---|---|
| `SUGERIR_COMPLEMENTO` | carrito con ítems y huecos en STARTER/MAIN/DRINK/DESSERT | Completar menú: hasta 2 categorías por ola. Un «no» (`refused`) abandona. Un «sí»/add de la oferta (`engaged`) habilita más olas con cooldown. Dual-inject opcional junto al Goal activo. |
| `CONFIRMAR_OFERTA` | el agente ofreció sumar un plato | Declarada. **TTL leído** en permiso y en el Fact de sesión (`isLastOfferAlive`). `maxSurfaces: 1` = planteos, no lifetime del dato: el `productId` sigue en `[ESTADO DEL CLIENTE]` aunque el presupuesto de Opportunity esté exhausted. |
| `SUGERIR_DIRECCION` | cliente sin dirección, **sin intent bloqueante** | ⚠️ **No confundir con `OBTENER_DIRECCION`.** Ver §6 |
| `OFRECER_PROMOCION` | promo **desbloqueable**: el carrito no cumple todavía y falta poco | Presupuesto 1. `tieBreak: 18` (entre `CONFIRMAR_OFERTA` 20 y `SUGERIR_COMPLEMENTO` 15). ⚠️ Una promo **ya aplicada** NO es Opportunity: es **Fact** — se comunica siempre, no gasta presupuesto y sobrevive a `refused` / `budget_exhausted` (mismo patrón que `CONFIRMAR_OFERTA`). Gate de relevancia mínima en el derivador, no en el ranker. |

> ⚠️ **Regla general:** Opportunities con presupuesto 1 (ADR-0008) — insistir es venta agresiva. **Excepción documentada:** `SUGERIR_COMPLEMENTO` interpreta el “1” como **un rechazo abandona**; tras aceptación (`engaged`) puede haber más olas acotadas por cooldown y `maxSurfaces`, no spam en cada mensaje.

---

## 4. ALERTS

**Deber de informar.** Iniciativa del **sistema**. Si nunca se emite, **el cliente se perjudica**.
Presupuesto: **1.** Cierre: **emisión** (registrada en el Ledger), salvo las que exigen resolución.

| Alert | Se deriva de | Cierre |
|---|---|---|
| `NEGOCIO_POR_CERRAR` | faltan < N min para el cierre, con pedido en curso | emisión |
| `ITEM_SIN_STOCK` | un ítem del pedido dejó de estar disponible | emisión |
| `PAGO_RECHAZADO` | intento de pago fallido | **cambio en un Fact** — emitirla no basta |
| `PEDIDO_POR_EXPIRAR` | el borrador está por vencer | emisión |
| `RESERVA_PROXIMA` | la reserva confirmada es inminente | emisión |
| `FUERA_DE_COBERTURA` | la dirección quedó fuera de zona tras un cambio de zonas | **cambio en un Fact** |

> **Una Alert crítica no puede ser silenciada por el cliente** (ADR-0008). Las que exigen resolución se comportan como Goals bloqueantes, y está bien que así sea.

---

## 5. OWNERSHIP

**Quién procesa este turno.** Exclusivo, determinista, **termina**.

| Ownership | Agente | Se activa | Se libera |
|---|---|---|---|
| `CHECKOUT` | agente de checkout | el cliente quiere cerrar y el pedido tiene ítems | pago, cancelación, handback, expiración |
| `RESERVA` | agente de reservas | intent de reserva o payload de reserva | confirmación, abandono |
| `ONBOARDING` | agente de onboarding | Facts incompletos (sin dirección usable **o** sin nombre, con refusal del Goal faltante en 0) **o** sesión/`onboarding_agent_active`/payload Confirmar\|Editar | dirección+nombre confirmados, `finish_onboarding`, o gate de refusal (no reabre por Facts) |
| `CAPTURA_DE_DIRECCION` | captura por texto | esperando dirección en texto libre | dirección capturada |
| `ASISTENTE_DEL_OWNER` | `owner_assistant` | el teléfono del remitente ∈ `owner_whatsapp_phones` | el teléfono deja la allowlist, o se apaga el flag. No hay sesión que limpiar. |
| `CONVERSACIONAL` | agente híbrido | **default** | — |

**Reglas:**
- Siempre hay **exactamente un** dueño. `CONVERSACIONAL` es la ruta default de **texto libre** (no pasa por familia Intent de runtime; botones siguen el mapper).
- **Ningún Intent participa de esta decisión** (ADR-0001).
- Ownership determina **qué Tools están al alcance** — es el mecanismo de contención de blast radius.
- Todo Ownership **debe** tener una condición de liberación. Si no la tiene, es un bug crítico. `ASISTENTE_DEL_OWNER` se libera por identidad (el teléfono deja de ser el dueño), no por un flag de sesión — un `owner_assistant_active` sin salida sería ADR-0001.

---

## 6. La distinción que más se equivoca

`awaiting_address` **no es un Goal.** Es dos cosas con el mismo nombre, y separarlas es obligatorio:

| Lo que significa | Categoría | Por qué |
|---|---|---|
| *"El próximo mensaje de texto debe interpretarse como una dirección"* | **Ownership** (`CAPTURA_DE_DIRECCION`) | Rutea. **Debe** liberarse o bloquea. |
| *"Falta la dirección para poder entregar"* | **Goal** (`OBTENER_DIRECCION`) | Puede quedar abierto indefinidamente. |
| *"Convendría que cargue una dirección para agilizar"* | **Opportunity** (`SUGERIR_DIRECCION`) | Nadie la pidió. Presupuesto 1. |

**Tres categorías, un solo nombre.** Es el ejemplo canónico de por qué la taxonomía existe: no para clasificar lo que ya está bien, sino para **detectar los conceptos que se resisten a ser clasificados** — que son siempre los que están rompiendo el sistema.

**Estado (2026-08-30): resuelto (V-09).** Las tres piezas existen por separado y con dueño: el Ownership es `shouldOwnOnboardingTurn`, el Goal es `OBTENER_DIRECCION` en el checkout, la Opportunity es `SUGERIR_DIRECCION`. El flag `awaiting_address` se borró. Vale conservar el ejemplo: la separación no se hizo partiendo el flag en tres, sino construyendo cada categoría en su lugar hasta que **el nombre fusionado se quedó sin escritores**. Cuando un concepto está bien clasificado, la fusión no se reparte: sobra.

Mismo anti-patrón (corregido): `awaitingPartySize` **no es un Goal.** El Goal es `OBTENER_PERSONAS_DEL_PEDIDO` (blocking, cierre por Fact). El tipable lo interpreta el ReAct. El flag —y con él `awaitingPeopleCount` y el snapshot `peopleCountResume`— se borró en 2026-08-30 al cerrar V-11.

Mismo anti-patrón, otra forma: `pendingOrderLines` (cola de platos de un mismo mensaje, PLAN-ACCION-PEDIDO-MULTI-LINEA.md) **tampoco es un Goal.** Es Facts de sesión (D1) que alimentan un **Constraint de supresión**: mientras haya línea `queued`/`active`, `COMPLETAR_PEDIDO` y `SUGERIR_COMPLEMENTO` no se derivan (D7) — no hace falta un `IntentType` nuevo en `INTENT_CATALOG`, el propio derivador de esos dos Intents lee el Fact `hasOpenOrderLines`.

---

## 7. CONSTRAINTS

Viven en el **borde de las Tools** (ADR-0002). **Ninguno puede existir únicamente en un prompt.**

| Constraint | Tool que lo aplica | Fact que evalúa |
|---|---|---|
| No confirmar una orden vacía | crear orden | pedido con ≥1 ítem |
| No cobrar sin método de pago | cobrar | método de pago presente |
| No delivery sin dirección en cobertura | confirmar entrega | dirección válida y en zona |
| No eliminar sin confirmación | eliminar ítem | evidencia de confirmación previa |
| No crear la orden sin confirmación final del total | crear orden / cobrar | el cliente confirmó el resumen (envío + ajuste de pago incluidos) |
| No operar fuera de horario | Tools de escritura | horario + `operate_when_closed` |
| No modificar un pedido ya confirmado | Tools de carrito | orden no confirmada |
| No sumar al carrito sin personas (Goal abierto) | `add_cart_item` → `party_size_required` | Fact `PERSONAS_DEL_PEDIDO` |
| **Orden del checkout** (entrega → dirección → nombre → pago) | función de orden | Facts del pedido y del cliente |
| No agregar un producto sin stock | agregar ítem | disponibilidad |
| No plantear COMPLETAR_PEDIDO / SUGERIR_COMPLEMENTO con cola de pedido abierta | derivadores de esos dos Intents (`orderCompletionGoal`, `opportunities.service`) | `hasOpenOrderLines` (`pendingOrderLines.service`) |
| No ofrecer complemento de una categoría que una promoción desbloqueable ya empuja | derivador de `SUGERIR_COMPLEMENTO` (`opportunities.service`) | `promotionSuppressedTags` (`promotionOpportunity.service`) |
| No cobrar un total que el cliente no confirmó por cambio de promoción | `createOrderFromDraft` → `PROMOTION_CHANGED` | evaluación al `now` de la creación vs. la del resumen |
| No activar una promoción que el motor no puede evaluar | `adminPromotions` → `PROMOTION_NOT_EVALUABLE` | whitelist de condiciones y beneficios (`promotionConditions`) |
| Idempotencia del cobro | cobrar | intento previo |
| No leer métricas del negocio si el teléfono no es el dueño | tools de `owner_assistant` (`withOwnerGate`) | `customerPhone` ∈ `owner_whatsapp_phones` |

---

## 8. TOOLS

Única superficie de efectos (ADR-0004). Cada una aplica sus Constraints **antes** de ejecutar.

| Categoría | Tools |
|---|---|
| **Lectura** (sin efectos) | buscar productos · detalle de producto · disponibilidad · categorías · carrito · horarios · info del negocio · historial · cobertura/costo de envío por dirección guardada (independiente del carrito) · estado de pedidos ya creados (lista, no solo el último) |
| **Lectura — owner** | briefing del período (dashboard + quejas + en vuelo) · cola operativa viva · detalle de un pedido. Solo con `withOwnerGate`. |
| **Escritura — carrito** | agregar ítem (aditivo o cantidad absoluta) · eliminar ítem · anotar instrucción especial · guardar nº de personas |
| **Escritura — checkout** | definir entrega · guardar dirección · guardar nombre · definir método de pago · **crear orden** · **cobrar** |
| **Escritura — dirección delegada** | dejar pendiente de confirmación una dirección compartida fuera de checkout/onboarding (señal-UI de confirmación aparte, nunca guarda por sí misma — ADR-0004) |
| **Escritura — reserva** | guardar borrador · confirmar reserva |
| **Intents** | declarar Intent (catálogo cerrado) · **abandonar Intent** (registra el abandono explícito en el Ledger) |

> **`abandonar` no borra el carrito.** Registra que el cliente pidió que no se insista. El pedido sigue vivo y el Goal revive si el cliente agrega otro ítem (ADR-0005, corolario del revival).

---

## 9. LEDGER

Memoria del **comportamiento del sistema**. **Debe poder borrarse entero sin consecuencias financieras** (ADR-0007).

| Entrada | Qué guarda |
|---|---|
| `surface_count` | Cuántas veces se planteó cada Intent |
| `last_surfaced_at` | Cooldown |
| `refusal_count` | Cuántas veces el cliente esquivó dar un dato |
| **`abandonment`** | **El cliente pidió explícitamente que no insistamos.** El único bit de continuidad inderivable |
| `expires_at` | TTL de Intents declarados y Opportunities |
| `surfaced_intent` | Qué Intent se planteó en este turno *(y por qué el sistema lo eligió)* |

**`surfaced_intent` es obligatorio y no negociable.** Sin la traza de por qué el sistema eligió lo que eligió, *"¿por qué el bot dijo eso?"* deja de tener respuesta, y esta arquitectura se vuelve una caja negra peor que la actual.

---

## 10. Checklist de clasificación

Para toda entidad nueva. **Si responde "sí" en dos categorías, está mal nombrada.**

| Pregunta | Si es sí → |
|---|---|
| ¿Un auditor lo verifica mirando solo los datos, sin conocer la conversación? | **Fact** |
| ¿Describe algo pendiente **que el cliente empezó**? | **Goal** |
| ¿Describe algo que **el negocio querría** y nadie pidió? | **Opportunity** |
| ¿Es algo que **el sistema debe avisar** aunque no se lo pregunten? | **Alert** |
| ¿Alguien lo lee para decidir **quién habla**? | **Ownership** |
| ¿**Debe limpiarse** o el sistema se rompe? | **Ownership** |
| ¿Debe cumplirse aunque el modelo se equivoque? | **Constraint** |
| ¿Modifica el mundo exterior? | **Tool** |
| ¿Recuerda lo que **hizo el bot**, no lo que le pasó al negocio? | **Ledger** |
| ¿Solo elige palabras y momento? | **LLM Expression** |

**Las dos preguntas que más rápido resuelven una duda:**

1. **Si esto nunca se cumple, ¿qué se rompe?** → Nada = **Opportunity** · El cliente no obtuvo lo que quería = **Goal** · El cliente se perjudica = **Alert**
2. **Si esto queda huérfano para siempre, ¿el sistema se rompe?** → Sí = **Ownership** · No = **Intent**
