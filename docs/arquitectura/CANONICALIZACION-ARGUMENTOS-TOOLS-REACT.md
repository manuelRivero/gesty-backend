# Canonicalización de argumentos en tools dependientes de ReAct

**Estado:** vivo. Patrón derivado del incidente real de `resolutionId` truncado entre `set_order_line_quantity` y `add_cart_item`.
**Referencia:** [`src/agents/humanIntentToolNode.ts`](../../src/agents/humanIntentToolNode.ts) · [`src/agents/postEffectToolNode.ts`](../../src/agents/postEffectToolNode.ts) · [`src/services/pendingOrderLines.service.ts`](../../src/services/pendingOrderLines.service.ts)

Este documento no es un ADR: no fija una decisión de dominio con alternativas de modelo descartadas, sino un patrón de ejecución para el **runtime** que corre entre dos tools dependientes de ReAct. Es complementario a [`CONTRATOS-RESPUESTA-TOOLS-REACT.md`](./CONTRATOS-RESPUESTA-TOOLS-REACT.md): aquel documenta qué debe decir la **respuesta** de una tool para no inducir al modelo a una decisión incorrecta; este documenta cuándo el runtime puede evitar depender de que el modelo **copie bien** un dato que ya conoce de forma canónica, en vez de solo informárselo por texto.

---

## El caso real

1. `set_order_line_quantity` persiste la cantidad confirmada de una `OrderLine` y, vía `PostEffectToolNode.runTool` ([`postEffectToolNode.ts:128-147`](../../src/agents/postEffectToolNode.ts#L128-L147)), calcula una transición de fulfillment con `fulfillmentTransitionFor` ([`postEffectToolNode.ts:29-48`](../../src/agents/postEffectToolNode.ts#L29-L48)) y devuelve `nextRequiredToolArgs` con `productId`, `resolutionId`, `orderLineId` y `quantity` canónicos, más la instrucción textual "copiá los valores sin modificarlos".
2. En una corrida real (LLM + Postgres, `e2e/text-only-completions.e2e.test.ts`), el modelo generó en su siguiente `tool_call` a `add_cart_item` un `resolutionId` **sin el último segmento** del identificador compuesto (`pr1:<businessId>:<conversationId>:<uuid>` sin el `:<uuid>` final). El `productId` se mantuvo íntegro; el campo de riesgo fue el identificador compuesto largo, no un UUID simple.
3. `add_cart_item` rechazó la llamada con `task_resolution_mismatch` ([`pendingOrderLines.service.ts:205-228`](../../src/services/pendingOrderLines.service.ts#L205-L228), `validateTaskResolutionOwnership`) — correctamente: el `resolutionId` recibido no coincidía con `OrderLine.currentResolutionId`.
4. El mecanismo de recuperación existente (`nextRequiredToolFor`/`taskRecoveryFor`) podía reofrecer los argumentos canónicos y el modelo, en un segundo intento, los copió bien — pero esa recuperación consumió una iteración ReAct adicional, y nada garantizaba que el segundo intento no fallara en otro campo.
5. La causa no era el `productId` (un UUID simple nunca se vio truncado en ninguna corrida observada) ni la ausencia de reinyección canónica (ya existía desde `set_order_line_quantity`): era que esa reinyección solo llegaba al modelo como **texto**, y la siguiente ejecución de `add_cart_item` dependía enteramente de que el modelo lo transcribiera sin error.

Este caso ilustra el patrón; no implica que toda tool dependiente de otra deba canonicalizarse de esta forma específica.

---

## Principio

**El LLM decide la acción conversacional; el runtime determina y valida los datos de control que ya conoce de forma canónica.**

Cuando el runtime puede identificar, de forma inequívoca y ya autorizada, una transición vigente hacia la siguiente tool, debe preferir los argumentos canónicos sobre los valores que el modelo generó para los campos que el sistema controla. El modelo sigue decidiendo **si** y **cuándo** ejecutar la operación — nunca deja de ser quien elige continuar, cancelar o hacer otra cosa — pero no es la fuente de verdad para identificadores que el sistema ya validó y persistió.

La canonicalización **no** reemplaza la autorización ni convierte una transición previa en un permiso permanente: se recalcula en cada ejecución contra el estado vigente, y si no hay una transición elegible, no sustituye nada.

---

## Flujo actual

1. `set_order_line_quantity` persiste un dato (la cantidad) necesario para continuar la operación.
2. `PostEffectToolNode` determina si existe una transición de fulfillment lista, releyendo metadata fresca y llamando `getFulfillmentReadyOrderLine`.
3. Al llegar el siguiente `tool_call` a `add_cart_item` (en una iteración ReAct posterior, ya sin relación estructural con el paso 1-2 salvo el estado persistido), `HumanIntentToolNode.runTool` repite el mismo cálculo — `canonicalAddCartItemArgs` ([`humanIntentToolNode.ts:377-399`](../../src/agents/humanIntentToolNode.ts#L377-L399)) — a partir del `orderLineId` explícito de la llamada entrante, reutilizando `getFulfillmentReadyOrderLine`/`getTaskCanonicalResolution`/`validateTaskResolutionOwnership`, las mismas funciones que ya validaban (de forma reactiva) el resultado antes de este cambio.
4. Si hay una Task lista y autorizada, construye una `effectiveCall` con `productId`/`resolutionId` canónicos ([`humanIntentToolNode.ts:1012-1024`](../../src/agents/humanIntentToolNode.ts#L1012-L1024)) **antes** de evaluar requisitos (`evaluateToolRequirement`) y de ejecutar la tool.
5. La evaluación de requisitos, los mensajes de rechazo y la ejecución final usan consistentemente `effectiveCall`, nunca la `call` original del modelo, para los campos canonicalizados.
6. Si no existe una transición elegible (línea no `active`, sin cantidad persistida, resolución vencida o no propia), `effectiveCall` queda igual a `call`: se conserva exactamente el comportamiento anterior, incluidas las validaciones fail-closed y el camino de rechazo/reintento.

```mermaid
sequenceDiagram
    participant Modelo as LLM (ReAct)
    participant Node as HumanIntentToolNode.runTool
    participant Runtime as getFulfillmentReadyOrderLine
    participant Tool as add_cart_item

    Modelo->>Node: tool_call add_cart_item<br/>(productId/resolutionId del modelo)
    Node->>Runtime: ¿hay transición lista para este orderLineId?
    alt Task lista y autorizada
        Runtime-->>Node: productId/resolutionId canónicos
        Node->>Node: construir effectiveCall (ids canónicos)
        Note over Modelo,Node: el modelo decidió llamar la tool;<br/>el runtime decidió los IDs de control
        Node->>Tool: ejecutar con effectiveCall
    else sin transición elegible
        Runtime-->>Node: null
        Node->>Tool: ejecutar con la call original<br/>(fail-closed, comportamiento previo)
    end
    Tool-->>Modelo: resultado (éxito o rechazo existente)
```

---

## Invariantes

Generales del patrón (aplican a cualquier par de tools dependientes que lo adopten):

- Los identificadores sustituidos deben pertenecer a la **misma** entidad destino (misma OrderLine, misma resolución) — nunca se infiere una correspondencia nueva.
- No se selecciona una resolución, línea o identificador por similitud textual, orden, historial o conveniencia. Si la relación no es inequívoca, no hay sustitución.
- El estado y la autorización deben validarse **en el momento de la sustitución**, no reutilizar un cálculo de una iteración anterior.
- Una transición obsoleta (estado cambiado, recurso vencido, entidad cerrada) nunca habilita un efecto: la ausencia de transición vigente siempre cae al comportamiento fail-closed existente.
- Los argumentos generados por el modelo no reemplazan los valores controlados por el sistema cuando existe una transición canónica válida — pero el patrón no decide **si** ejecutar la tool; esa decisión sigue siendo del modelo.
- La canonicalización reutiliza las validaciones de ownership/autorización ya existentes; no las debilita ni las duplica con una lógica paralela.

Particulares del flujo de pedidos (no generalizables a otros dominios sin revisar su propio contrato):

- `quantity` **no** se canonicaliza en este punto: sigue siendo resuelta exclusivamente dentro de `addCartItemTool.func` ([`tools/index.ts`](../../src/tools/index.ts), evento `order_line_quantity_arg_ignored`), que ya descartaba el valor del modelo a favor del persistido. Evitar una segunda fuente de verdad para el mismo campo fue una decisión explícita de esta implementación.
- La transición solo se calcula cuando el `orderLineId` es explícito (viene en `call.args` o en `config.configurable`) — sin `orderLineId`, no hay candidato a canonicalizar.
- Esta canonicalización corre únicamente dentro del camino de `HumanIntentToolNode` ya gateado por `humanIntentGateRevision` numérico y una intención `ACTIVE` — no es un interceptor global sobre todas las tools.

---

## Cuándo aplicar este patrón

Aplicarlo cuando, simultáneamente:

- Una operación posterior depende de identificadores o datos de control que el runtime ya conoce y ha persistido/validado.
- Es posible vincular esos datos, de forma inequívoca, a una transición vigente hacia la llamada concreta que está por ejecutarse (no "una transición cualquiera que exista").
- La autorización y el estado pueden revalidarse en el momento de la sustitución sin depender de los argumentos que trajo el modelo.

**No** aplicarlo automáticamente cuando:

- El valor representa una elección legítima del usuario que todavía no se resolvió (p. ej. qué producto quiere, cuántas unidades — esos siguen siendo datos que el modelo/usuario aportan, no el sistema).
- No existe una relación inequívoca entre el resultado de la tool anterior y la operación siguiente (varias transiciones posibles, ninguna claramente "la" correspondiente).
- El estado pudo haber cambiado y no hay forma de revalidarlo en el momento exacto de la sustitución.
- Sustituir el argumento alteraría la semántica de la tool o el contrato de autorización (por ejemplo, forzar una operación que el usuario no pidió).
- La única forma de "resolver" la sustitución sería adivinar una identidad o elegir una entidad arbitrariamente (última, primera, más similar).

Este patrón **no** implica canonicalizar indiscriminadamente todos los argumentos de todas las tools, ni introducir un interceptor global de argumentos en el `ToolNode`. Es una sustitución puntual, acotada a los campos de control de una transición concreta y ya autorizada.

---

## Qué NO se infiere de este caso

- Que `resolutionId` sea el único campo en riesgo de copia incorrecta en cualquier flujo — fue el campo observado en este incidente, por ser un identificador compuesto largo.
- Que toda pareja de tools dependientes en ReAct necesite este mismo mecanismo — solo aplica donde el runtime puede calcular la transición de forma determinista y sin ambigüedad.
- Que la validación de ownership (`validateTaskResolutionOwnership`) se haya debilitado — sigue siendo la misma función, ahora invocada también de forma proactiva además de reactiva.
- Que la última corrida E2E haya reproducido el truncamiento original: el comportamiento del LLM no es determinista entre corridas, y esa corrida no lo reprodujo (ver evidencia).
- Que este documento reemplace o derogue `CONTRATOS-RESPUESTA-TOOLS-REACT.md` — ambos documentan capas distintas del mismo ciclo ReAct (respuesta de la tool anterior vs. argumentos de ejecución de la siguiente).

---

## Tests como parte del patrón

Las pruebas que verifican este patrón —presentes y futuras— deben comprobar, en este orden de prioridad:

1. **Sustitución bajo transición autorizada**: con una Task lista (cantidad persistida, resolución propia vigente) y argumentos del modelo deliberadamente incorrectos (identificador truncado, producto equivocado), la ejecución real de la tool recibe los valores canónicos, no los del modelo.
2. **Sin transición elegible, se conserva el rechazo existente**: sin cantidad persistida o sin resolución propia, no se inventa ni sustituye nada; el camino de error/recuperación anterior sigue intacto.
3. **Sin mezcla entre entidades**: con varias OrderLines/resoluciones coexistiendo, la sustitución para una línea nunca toca ni consume la resolución o cantidad de otra.
4. **Fuente de verdad de campos no canonicalizados**: `quantity` sigue resuelta por la lógica existente en `addCartItemTool.func`, no por este mecanismo.
5. **Estado obsoleto no habilita el efecto**: una transición que ya no es válida (resolución vencida, línea cerrada) no debe producir sustitución ni ejecución del efecto.

Estas verificaciones deben priorizarse como pruebas deterministas que inspeccionen los argumentos realmente recibidos por la ejecución de la tool — no inferirlas del contenido textual de una respuesta anterior. Un E2E real (LLM + Postgres) sigue siendo necesario para validar la integración completa, pero no es el mecanismo para reproducir de forma confiable un fallo de generación del LLM que no es determinista entre corridas: ese nivel de evidencia solo lo da la prueba determinista.

---

## Evidencia (archivos y resultados citados)

- [`src/agents/humanIntentToolNode.ts`](../../src/agents/humanIntentToolNode.ts) — `canonicalAddCartItemArgs` (líneas 377-399) y su uso en `HumanIntentToolNode.runTool` dentro de la rama `call.name === 'add_cart_item'` (líneas ~1006-1102).
- [`src/agents/postEffectToolNode.ts`](../../src/agents/postEffectToolNode.ts) — `fulfillmentTransitionFor` (líneas 29-48) y `PostEffectToolNode.runTool` (líneas 50-190, relevante 128-147): el mecanismo de reinyección textual preexistente que motivó el patrón.
- [`src/services/pendingOrderLines.service.ts`](../../src/services/pendingOrderLines.service.ts) — `getTaskCanonicalResolution` (líneas 1208-1236), `getFulfillmentReadyOrderLine` (líneas 1239-1252), `validateTaskResolutionOwnership` (líneas 205-228): las funciones reutilizadas, sin duplicar su lógica.
- [`src/tools/index.ts`](../../src/tools/index.ts) — sustitución preexistente de `quantity` por el valor persistido (evento `order_line_quantity_arg_ignored`), que este patrón no reemplaza ni duplica.
- [`src/tools/__tests__/productResolutionAddCart.test.ts`](../../src/tools/__tests__/productResolutionAddCart.test.ts) — describe `HumanIntentToolNode canonicaliza add_cart_item para Tasks listas (runtime, no el modelo)`: reproduce el incidente con un `resolutionId` truncado y un `productId` incorrecto deliberados, verifica el rechazo existente sin transición lista, y verifica ausencia de contaminación cruzada entre dos Tasks.

Resultados verificados al incorporar el patrón:

- Suite completa: **1727 tests pasados, 201 archivos** (`npx vitest run`).
- `npx tsc --noEmit`: sin errores.
- `e2e/text-only-completions.e2e.test.ts` (LLM + Postgres reales): 3/3 pasaron. En esa corrida puntual el modelo generó el `resolutionId` completo (no truncado) — el comportamiento del LLM no es determinista entre corridas, por lo que esta corrida **no** reprodujo el truncamiento original; confirma que el camino feliz y el mecanismo de `quantity` no se rompieron, no que el patrón haya sido ejercitado bajo el fallo exacto.
- La reproducción determinista del incidente (truncamiento deliberado → sustitución por canónicos) está en el test unitario citado arriba, no en la corrida E2E.
