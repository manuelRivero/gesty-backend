# Contratos de respuesta en tools de ReAct

**Estado:** vivo. Patrón derivado del cierre de CASE08 (desambiguación + cola multi-línea en `pendingOrderLines`).
**Referencia:** [`src/services/pendingOrderLines.service.ts`](../../src/services/pendingOrderLines.service.ts) · [`src/tools/index.ts`](../../src/tools/index.ts)

Este documento no es un ADR: no fija una decisión de dominio con alternativas descartadas, sino un patrón de diseño para la **respuesta** que una tool le devuelve al ReAct — el canal por el que el modelo decide su próxima llamada. Aplica a cualquier tool nueva que alimente un agente ReAct en este repo, no solo a `pendingOrderLines`.

---

## El caso real

**Estado inicial** (después de agregar el ceviche al carrito): la línea `ceviche` en `pendingOrderLines.lines` está `done`, con su `currentResolutionId`, `requestedQuantity: 2` y `pendingNote: "poca cebolla"` ya persistidos. La línea `papas a la huancaína` sigue `queued`.

1. El cliente dice "Seguí". El modelo llama `plan_order_lines` con las **mismas** dos líneas del pedido original (ceviche + papas) en vez de `continue_order_line()`.
2. `reconcileOrderLinesPlan` ([pendingOrderLines.service.ts:859](../../src/services/pendingOrderLines.service.ts#L859)) reconoce que ambos platos ya están representados en la cola persistida y hace un **no-op correcto**: no reabre el ceviche, no toca su identidad ni su resolución, no reordena nada.
3. Pero `planOrderLinesTool.func` ([tools/index.ts:4239](../../src/tools/index.ts#L4239), antes del fix) construía su respuesta con `getActiveOrderLine(pending)` — una función con **fallback a la primera línea `queued`** cuando no hay ninguna `active` (pensada para mostrar "qué línea trabajar" en contextos de UI/log, no para certificar una transición de estado). Con ceviche `done` y papas `queued`, ese fallback devolvía la línea de papas como si fuera la activa.
4. La respuesta de la tool decía entonces `"activeLine": {"hint": "papas a la huancaína"}` con la instrucción *"Trabajá ahora SOLO 'papas'... llamá search_products... y resolve_product con el orderLineId de esa línea"* — sin mencionar `continue_order_line()` en ningún momento.
5. El modelo, siguiendo fielmente esa instrucción, llamó `search_products` y `resolve_product` directo sobre la línea de papas. `resolve_product` rechazó la operación con `task_not_active` — correctamente: la línea seguía `queued`, no `active`.
6. El fix separó, en `planOrderLinesTool.func`, la búsqueda de una línea **realmente** `active` (`pending.lines.find(l => l.status === 'active')`, sin fallback) de la mera presencia de líneas `queued`. Cuando no hay línea activa real pero sí hay cola, la instrucción pasó a decir explícitamente *"llamá `continue_order_line()`... PROHIBIDO search_products o resolve_product antes de activarla"*.
7. Con el fix, una corrida real (LLM + Postgres) mostró al modelo llamando `continue_order_line()` en el turno siguiente, activando papas, resolviéndola y agregándola al carrito con su cantidad y nota correctas — las 10 invariantes del caso pasaron.

El caso ilustra el patrón; no es una regla de que toda cola de líneas deba resolverse de esta forma específica.

---

## Principios

### A. Estado real y estado presentado no son equivalentes

El estado persistido del dominio (`OrderLine.status: 'queued' | 'active' | 'done' | 'cancelled'`) y una función de conveniencia que elige **qué mostrar** (`getActiveOrderLine`, con su fallback a la primera `queued`) responden preguntas distintas. Una función de presentación no debe reutilizarse automáticamente para decidir qué operación es válida ejecutar a continuación. Si una tool necesita saber "¿hay una línea genuinamente activa?", debe preguntarlo directamente (`lines.find(l => l.status === 'active')`), no a través de un helper con fallback pensado para otro consumidor.

### B. Las respuestas de tools son parte del contrato operativo de ReAct

El modelo decide su siguiente acción a partir del resultado de la última tool, no solo del contexto general. Una respuesta exitosa (`success: true`) no debe insinuar que ocurrió una transición que el estado no confirma. En este caso, `success: true` + `activeLine: {...}` le dijo al modelo "ya podés trabajar esta línea", cuando el estado real decía lo contrario.

### C. Distinguir estado, resultado y próxima acción (cuando sea relevante)

No es un formato universal obligatorio, pero cuando una tool puede devolver un no-op o un resultado parcial, conviene que la respuesta pueda separar: qué cambió realmente, si la operación fue un no-op, qué precondición falta y cuál es la próxima transición determinada por el contrato (si existe una). No todas las tools necesitan los cuatro campos — depende de si hay ambigüedad real que el modelo pueda interpretar mal.

### D. Los no-op también necesitan contratos claros

Una llamada que no modifica nada (`reconcileOrderLinesPlan` devolviendo la cola existente sin cambios) sigue influyendo en la decisión del modelo. La respuesta debe decir que no hubo cambios y no presentar como activa, resuelta o completada una entidad que no alcanzó ese estado — el bug de este caso fue exactamente esto.

### E. Las validaciones de dominio siguen siendo la última barrera

No se resuelve este tipo de defecto debilitando las precondiciones de las tools siguientes. `resolve_product` rechazó correctamente la línea `queued` con `task_not_active` ([src/tools/index.ts:560](../../src/tools/index.ts#L560), gate ya existente); la corrección fue arreglar la información que guiaba a ReAct hacia esa tool en el momento equivocado, no relajar el gate de `resolve_product` para que aceptara una línea inactiva.

### F. Las instrucciones contradictorias son un problema de contrato, no de LLM

El contexto general (`buildPendingOrderLinesContextLines` en `pendingOrderLines.service.ts`) ya decía, en el caso "sin línea activa, hay queued", que había que usar `continue_order_line()`. La respuesta de `plan_order_lines` —fuente más inmediata, al ser el resultado de la última tool llamada— decía otra cosa. Ante una contradicción así, la auditoría debe identificar cuál señal es más inmediata para el modelo y por qué compite con la otra, en vez de atribuir el resultado a que "el LLM no siguió las instrucciones".

### G. Probar transiciones y decisiones, no solo funciones aisladas

Un test que demuestra que `continue_order_line()` hace la transición correcta ([src/tools/__tests__/continueOrderLine.test.ts](../../src/tools/__tests__/continueOrderLine.test.ts)) no demuestra que ReAct la vaya a elegir. Son capas distintas:
- **Unitario de transición de estado** — ej. los tests de `reconcileOrderLinesPlan`/`advanceAfterLineClose` en [src/services/__tests__/pendingOrderLines.service.test.ts](../../src/services/__tests__/pendingOrderLines.service.test.ts): verifican que el dominio cambia (o no cambia) correctamente.
- **De tool (respuesta + precondiciones)** — ej. el test agregado en [src/tools/__tests__/planOrderLinesComplement.test.ts](../../src/tools/__tests__/planOrderLinesComplement.test.ts) ("CASE08 — no-op total...") que verifica que la respuesta no ofrece `activeLine` falso ni instruye `search_products`/`resolve_product`; o los tests de `task_not_active` en [src/tools/__tests__/productResolutionAddCart.test.ts](../../src/tools/__tests__/productResolutionAddCart.test.ts).
- **De integración ReAct** — verifica que, dado el contexto y la respuesta de la tool anterior, el modelo elige la tool correcta. Este nivel solo se valida de forma determinista hasta donde el contrato lo permite; la elección real del modelo requiere la capa siguiente.
- **E2E real (LLM + Postgres)** — el único nivel que demuestra que el modelo, con el contrato corregido, efectivamente llama `continue_order_line()` en la práctica (ver `e2e/human-intent-lifecycle.e2e.test.ts`, CASE08).

Ninguna capa sustituye a las demás.

---

## Checklist para una tool nueva que alimenta ReAct

- ¿La respuesta describe el estado real posterior a la ejecución, no una proyección de conveniencia?
- ¿Distingue entidades activas, pendientes, completadas y canceladas cuando esos estados existen en el dominio?
- ¿Un no-op queda identificado como tal, sin presentar algo como activo/resuelto/guardado si no lo está?
- ¿La respuesta puede inducir a ejecutar una tool cuyas precondiciones todavía no se cumplen?
- ¿Las instrucciones de la respuesta contradicen el contexto general que el agente ya tenía? Si sí, ¿cuál señal es más inmediata y por qué compiten?
- ¿Se reutilizó algún helper de presentación (con fallback, redondeo, "mejor opción", etc.) en una decisión operativa sin revisar su semántica exacta?
- ¿Los rechazos de la tool (errores de precondición) orientan una recuperación coherente sin debilitar la validación que rechazó?
- ¿Hay tests del resultado de la tool y del estado persistido, no solo de la función interna que hace la transición?
- ¿Se probó la decisión siguiente en integración ReAct (o en una corrida E2E real) cuando el contrato de la respuesta influye en qué tool elige el modelo?

---

## Qué NO se infiere de este caso

- Que toda respuesta de tool necesite un campo literal `nextAction` o un formato universal — el principio C es de criterio, no de esquema obligatorio.
- Que cada tool deba incorporar lógica propia de orquestación del flujo completo.
- Que todos los errores de este tipo se resuelvan agregando instrucciones al prompt — en este caso el fix fue en el código de la tool, no en el prompt general.
- Que los tests deterministas sustituyan a una corrida E2E real cuando lo que se valida es qué tool elige el modelo.
- Que los no-op deban comunicarse siempre de la misma manera, independientemente del dominio de la tool.
- Que `getActiveOrderLine` sea incorrecta para todos sus usos. Sigue siendo válida para contextos de presentación (UI, logs, mensajes al cliente); el problema fue reutilizar su fallback en un punto que necesitaba saber si existía una línea **realmente** activa.

---

## Evidencia (archivos citados)

- [`src/services/pendingOrderLines.service.ts`](../../src/services/pendingOrderLines.service.ts) — `reconcileOrderLinesPlan`, `getActiveOrderLine`, `advanceAfterLineClose`: propietario del ciclo de vida y la reconciliación de `pendingOrderLines`.
- [`src/tools/index.ts`](../../src/tools/index.ts) — `planOrderLinesTool.func` (la respuesta corregida), `resolveProductTool`/`resolve_product` (gate `task_not_active` que ya protegía el dominio), `continueOrderLineTool`/`continue_order_line`, `cancelOrderLineTool`/`cancel_order_line`.
- [`src/tools/__tests__/planOrderLinesComplement.test.ts`](../../src/tools/__tests__/planOrderLinesComplement.test.ts) — test del no-op con una línea `done` y otra `queued`.
- [`src/tools/__tests__/continueOrderLine.test.ts`](../../src/tools/__tests__/continueOrderLine.test.ts) — transición `queued → active` sin alterar la línea `done`.
- [`src/tools/__tests__/cancelOrderLineRecoveryGuard.test.ts`](../../src/tools/__tests__/cancelOrderLineRecoveryGuard.test.ts) — por qué un rechazo de tool no debe derivar en una cancelación destructiva.
- [`src/tools/__tests__/productResolutionAddCart.test.ts`](../../src/tools/__tests__/productResolutionAddCart.test.ts), [`src/services/__tests__/pendingOrderLines.service.test.ts`](../../src/services/__tests__/pendingOrderLines.service.test.ts) — rechazo `task_not_active` sobre una línea `queued`.
- `e2e/human-intent-lifecycle.e2e.test.ts` (CASE08) — validación real del patrón corregido con LLM y Postgres.
