# Casos de prueba manual — Goal Engine (Fases −1, 0, 1, 1b)

**Contexto:** verifica, contra el bot real (WhatsApp sandbox o número de prueba), todo lo implementado en la migración a la arquitectura conversacional descripta en [`ARQUITECTURA.md`](../../ARQUITECTURA.md): las precondiciones de seguridad (Fase −1), el primer Goal derivado (Fase 0), la exposición de checkout (Fase 1) y reservas (Fase 1b). Todo pasa `tsc --noEmit` y `npm test`, pero **ningún escenario fue probado contra el bot real** — esta tabla es el checklist para hacerlo.

Convención: cada caso indica **setup**, **acción**, **resultado esperado** y **qué verifica** (para saber qué ADR/violación confirma el caso, y qué log buscar si algo no cierra).

**Logs útiles para correlacionar mientras se prueba:**
- `[goal] order_completion_ledger` — estado del Goal de carrito en cada turno del híbrido.
- `[goal] reservation_completion_ledger` — ídem para reservas.
- `[goal] checkout_step` — paso derivado del checkout en cada turno de esa sesión.
- `[EscalationGate]` — disparo del interrupt de escalamiento.
- `[checkout-agent] validation_corrected` — el LLM propuso saltear un paso y la Constraint lo corrigió.
- `[reservation-agent] handback_reservation` / `abandon_reservation` — cuál de las dos salidas se usó.

---

## Dominio: Carrito — confirmación de eliminación (V-01, ADR-0002)

### Caso 1 — Eliminar un ítem exige confirmación explícita

**Setup:** agregar 1 producto al carrito.

**Acción:** escribir "sacá el/la {producto}".

**Resultado esperado:**
1. El bot **no** elimina el ítem en este turno — pregunta si confirmás.
2. El ítem sigue en el carrito (verificar con "qué tengo en el carrito").

**Acción 2:** confirmar ("sí, sacalo").

**Resultado esperado 2:** ahora sí se elimina, y el bot lo confirma.

**Qué verifica:** el Constraint vive en el borde de la Tool (`remove_cart_item`), no en el prompt — el primer llamado nunca borra sin importar qué decida el modelo.

---

### Caso 2 — La confirmación no cruza productos distintos

**Setup:** carrito con 2 productos (A y B).

**Acción:** pedir eliminar A (sin confirmar) y, sin confirmar, pedir eliminar B.

**Resultado esperado:** ninguno de los dos se elimina — cada producto necesita su propia confirmación con el mismo `productId`.

**Qué verifica:** la evidencia de confirmación es específica por producto, no un flag genérico que el modelo pueda reusar.

---

## Dominio: Escalamiento a humano (V-02, ADR-0002)

### Caso 3 — Pedido explícito de hablar con una persona, en medio de checkout

**Setup:** carrito con ítems → "quiero pagar" (activa checkout) → el bot pregunta delivery o retiro.

**Acción:** en vez de responder, escribir "quiero hablar con una persona, por favor".

**Resultado esperado:**
1. El bot corta inmediatamente a un mensaje de derivación a un asesor humano — **no** contesta como si fuera parte del flujo de checkout.
2. No debe intentar seguir preguntando delivery/retiro en el mismo mensaje.

**Qué verifica:** el interrupt de escalamiento corre **antes** de que Ownership decida qué agente procesa el turno — nunca llega al agente de checkout, sin excepción de sesión.

---

### Caso 4 — Botón "Pedir ayuda" también escala dentro de una sesión

**Setup:** provocar el mensaje de "no puedo procesar este tipo de mensaje" (mandar una imagen o audio) para que aparezca el botón "Pedir ayuda". Si no es práctico, alternativamente activar checkout y usar cualquier flujo que muestre ese botón.

**Acción:** tocar el botón "Pedir ayuda".

**Resultado esperado:** deriva a humano igual que el Caso 3, sin pasar por ningún agente de sesión.

**Qué verifica:** el gate cubre tanto texto libre como el payload `SUPPORT`.

---

### Caso 5 — Frase ambigua NO dispara un falso positivo

**Setup:** cualquier conversación normal.

**Acción:** escribir "somos 4 personas para comer" (contiene "personas" pero no pide contacto humano).

**Resultado esperado:** el bot sigue la conversación normalmente — **no** deriva a un humano.

**Qué verifica:** el detector es conservador (regex con verbo de contacto + sustantivo de persona), no dispara con menciones sueltas de "persona(s)".

---

## Dominio: Continuidad del pedido — `COMPLETAR_PEDIDO` (Fase 0, ADR-0005/0008/0009)

### Caso 6 — El bot retoma el pedido pendiente tras una charla lateral

**Setup:** agregar 1-2 productos al carrito. **No** iniciar checkout.

**Acción:** preguntar algo lateral: "¿hasta qué hora están abiertos?".

**Resultado esperado:**
1. El bot responde el horario real.
2. En el mismo turno o el siguiente (dependiendo del cooldown/turno), puede ofrecer retomar el pedido — sin ser insistente ni interrumpir la respuesta a la consulta.

**Qué verifica:** el Goal `COMPLETAR_PEDIDO` está en la función objetivo del modelo — la continuidad ya no depende de que el modelo "se acuerde" solo.

---

### Caso 7 — Presupuesto de insistencia: enmudece a las 3 veces

**Setup:** carrito con ítems, sin iniciar checkout.

**Acción:** mantener varias charlas laterales espaciadas (esperando el cooldown de 10 min entre cada una, o revisando directamente el log `[goal] order_completion_ledger`) hasta acumular 3 planteos del Goal.

**Resultado esperado:** a partir del cuarto turno con permiso potencial, el bot **deja de mencionar** el pedido — pero el carrito sigue intacto y el bot lo sigue sabiendo (no lo "olvida", solo deja de insistir).

**Qué verifica:** ADR-0008 — "un Goal que agota su presupuesto enmudece pero no muere". Log: `surfaceCount` llega a 3, `permission: budget_exhausted`.

---

### Caso 8 — Cooldown entre planteos consecutivos

**Setup:** justo después de que el bot mencionó el pedido pendiente (Caso 6).

**Acción:** dos charlas laterales seguidas, con menos de 10 minutos entre sí.

**Resultado esperado:** el bot **no** vuelve a mencionar el pedido en la segunda charla lateral, aunque el Goal siga abierto.

**Qué verifica:** log `[goal] order_completion_ledger` con `permission: cooldown` en el segundo turno.

---

### Caso 9 — Abandono explícito no borra el carrito

**Setup:** carrito con ítems, bot ya mencionó el pedido pendiente al menos una vez.

**Acción:** "dejalo, no me insistas más con el pedido".

**Resultado esperado:**
1. El bot confirma que no va a insistir más.
2. El carrito **sigue teniendo los ítems** (verificar con "qué tengo en el carrito").
3. En charlas laterales posteriores, el bot **no** vuelve a mencionar el pedido.

**Qué verifica:** la Tool `abandon_pending_order` — ADR-0005, "el único bit que separa un asistente de un acosador".

---

### Caso 10 — Revival: agregar otro ítem reactiva el Goal

**Setup:** continuar desde el Caso 9 (pedido abandonado, ya no se menciona).

**Acción:** agregar un producto nuevo al carrito.

**Resultado esperado:** el silencio se levanta — en charlas laterales futuras el bot puede volver a ofrecer cerrar el pedido (con presupuesto y cooldown reseteados).

**Qué verifica:** el corolario de revival de ADR-0005 — sin esto, un pedido abandonado y luego retomado nunca recibiría ayuda para cerrarse.

---

### Caso 11 — El Goal no se plantea con el carrito vacío

**Setup:** sin ítems en el carrito.

**Acción:** cualquier charla normal (consultas de menú, horarios, etc.).

**Resultado esperado:** el bot nunca menciona un "pedido pendiente" — no hay nada que retomar.

**Qué verifica:** `deriveOrderCompletionGoal`: `open` requiere `hasItems`.

---

### Caso 12 — El Goal no compite mientras el checkout está activo

**Setup:** carrito con ítems, checkout activo (el agente de checkout tiene el turno).

**Acción:** cualquier interacción dentro del checkout.

**Resultado esperado:** nunca aparece un mensaje de "¿seguimos con tu pedido?" superpuesto — el checkout ya está gestionando ese mismo pedido.

**Qué verifica:** Ownership (ADR-0001) es exclusivo; el híbrido (dueño del Goal `COMPLETAR_PEDIDO`) no procesa turnos mientras el checkout tiene la sesión.

---

## Dominio: Checkout — Goals expuestos, reconciliador eliminado (Fase 1, V-06/V-08)

### Caso 13 — Un solo mensaje al presentar el tipo de entrega

**Setup:** carrito con ítems → "quiero pagar".

**Resultado esperado:** el bot manda **un solo mensaje** interactivo con los botones Delivery/Retiro — no un texto seguido de un followUp separado repitiendo la pregunta.

**Qué verifica:** persiste el fix de consolidación de mensajes de la Tarea 4.1 (no relacionado a V-06/V-08 directamente, pero comparte la misma superficie — confirma que no se rompió con la eliminación del flag).

---

### Caso 14 — Resume tras interrupción retoma el paso correcto

**Setup:** checkout activo, el bot pregunta delivery/retiro.

**Acción:** preguntar algo lateral ("¿aceptan Mercado Pago?").

**Resultado esperado:** el bot responde la consulta **y** retoma exactamente "¿delivery o retiro?" con los botones — no salta al paso de pago ni repite una pregunta ya respondida.

**Qué verifica:** `resolveCheckoutPendingFromStep` deriva el paso desde `nextCheckoutStep` en tiempo real — no depende de un flag que pudo haber quedado desactualizado (el bug que resolvía el reconciliador eliminado).

---

### Caso 15 — No se puede saltar a pago sin resolver un paso previo

**Setup:** checkout activo, sin tipo de entrega definido todavía.

**Acción:** intentar forzar el pago en el mismo mensaje ("dale, cobrame ya" antes de elegir delivery/retiro).

**Resultado esperado:** el bot no muestra botones de pago — vuelve a pedir el tipo de entrega primero.

**Qué verifica:** `validateCheckoutResponse` sigue corrigiendo transiciones inválidas contra `nextCheckoutStep` (la Constraint de orden, ADR-0006), independiente de la eliminación del flag de pending.

---

### Caso 16 — Resolver un paso "por el costado" no dispara un pending obsoleto

**Setup:** checkout activo, el bot preguntó el tipo de entrega (botones mostrados).

**Acción:** en vez de tocar un botón, escribir en texto libre "delivery, por favor".

**Resultado esperado:** el bot reconoce el tipo de entrega, avanza al siguiente paso (dirección/nombre/pago) sin volver a preguntar por el tipo de entrega ni quedarse "pegado" en un estado viejo.

**Qué verifica:** como el paso se deriva del draft real (no de un flag persistido), resolver por cualquier camino lo actualiza automáticamente — es la clase de bug que el reconciliador existía para tapar, y que ahora no puede ocurrir.

---

### Caso 17 — El pedido no se cobra al elegir método: hay un paso de revisión final (V-18)

**Setup:** checkout activo, con dirección de delivery ya cargada (para que el envío tenga un costo real, no $0).

**Acción:** tocar "💵 Efectivo" (o cualquier botón de método de pago).

**Resultado esperado:**
1. El bot **no** confirma el pedido en este mensaje — muestra un resumen con ítems, envío real, ajuste del método elegido (si aplica) y el total final, con dos botones: "✅ Confirmar pedido" / "❌ Cancelar".
2. El pedido **todavía no existe** como orden (no hay número de pedido ni QR).

**Qué verifica:** la Constraint nueva — elegir el método ya no dispara el cobro por sí solo.

---

### Caso 18 — Confirmar el resumen sí crea la orden

**Setup:** continuar desde el Caso 17 (resumen mostrado).

**Acción:** tocar "✅ Confirmar pedido".

**Resultado esperado:** recién ahora se crea la orden — mensaje "Pedido confirmado" con número de pedido, y el total coincide exactamente con el que mostró el resumen del Caso 17.

**Qué verifica:** el mismo cálculo de precio se usa para mostrar y para cobrar — no hay dos fuentes que puedan desincronizarse.

---

### Caso 19 — Cancelar el resumen vuelve a pedir el método, sin perder el resto de los datos

**Setup:** continuar desde el Caso 17 (resumen mostrado).

**Acción:** tocar "❌ Cancelar".

**Resultado esperado:** el bot vuelve a preguntar el método de pago (botones de nuevo) — **sin** volver a pedir tipo de entrega, dirección ni nombre (esos datos siguen guardados).

**Qué verifica:** cancelar revierte solo el método de pago (`nextCheckoutStep` vuelve al paso `payment`), no reinicia el checkout entero.

---

### Caso 20 — Confirmación en texto libre (sin tocar botones)

**Setup:** continuar desde el Caso 17 (resumen mostrado, con botones).

**Acción:** en vez de tocar un botón, escribir "sí, confirmo".

**Resultado esperado:** mismo resultado que el Caso 18 — se crea la orden. Probar también con "no, mejor cancelá" y verificar que da el mismo resultado que el Caso 19.

**Qué verifica:** el paso de confirmación funciona igual por botón o por texto libre — mismo pipeline de extracción que ya usan fulfillment/payment.

---

### Caso 21 — Interrupción durante la confirmación no pierde el resumen

**Setup:** continuar desde el Caso 17 (resumen mostrado).

**Acción:** preguntar algo lateral ("¿tienen wifi?") en vez de responder a la confirmación.

**Resultado esperado:** el bot responde la consulta lateral **y** retoma el resumen de confirmación completo (con el total, no solo el texto "¿confirmás tu pedido?" pelado) con los botones.

**Qué verifica:** el resume-follow-up tras interrupción (H-03) también cubre el paso nuevo, no solo fulfillment/payment.

---

## Dominio: Reservas — `handback_reservation` y `COMPLETAR_RESERVA` (Fase 1b, V-15)

### Caso 22 — Pedir el menú en medio de una reserva conserva el borrador

**Setup:** iniciar una reserva (agente nuevo, no wizard legacy) → llegar hasta que pida fecha u horario, con al menos un dato ya cargado (ej. fecha elegida).

**Acción:** "che, ¿tienen menú vegetariano?" (algo que implique querer ver el menú, no solo preguntar de pasada).

**Resultado esperado:**
1. El bot responde sobre el menú (posiblemente muestra opciones).
2. La sesión de reservas se cierra para este turno — el próximo mensaje normal **no** vuelve automáticamente al flujo de reserva paso a paso.
3. Los datos ya cargados de la reserva (fecha, horario, etc.) **no se pierden** — verificar en el Caso 18.

**Qué verifica:** la Tool `handback_reservation`, nueva en esta fase — a diferencia del wizard legacy, esto no debería dejar al cliente en un limbo ni borrar lo ya cargado.

---

### Caso 23 — Retomar la reserva después del handback

**Setup:** continuar desde el Caso 17.

**Acción:** en algún momento posterior, escribir "che, sigamos con la reserva" o similar.

**Resultado esperado:** el bot retoma desde donde había quedado (no vuelve a pedir la fecha si ya estaba cargada).

**Qué verifica:** `reservation_draft` sobrevivió al handback — es la pieza estructural que hace posible `COMPLETAR_RESERVA`.

---

### Caso 24 — Abandono explícito de la reserva sí borra el borrador

**Setup:** reserva en curso con datos cargados.

**Acción:** "no quiero reservar más, cancelá todo" (dentro de la sesión de reservas).

**Resultado esperado:** la sesión se cierra y, a diferencia del Caso 17/18, si más adelante el cliente quiere reservar arranca **de cero** (no recuerda la fecha/horario anteriores).

**Qué verifica:** `abandon_reservation` sigue siendo la salida permanente que borra todo — distinta de `handback_reservation`. Confirma que el LLM elige la tool correcta según el prompt actualizado.

---

### Caso 25 — El bot ofrece retomar una reserva pendiente en charla normal

**Setup:** provocar el escenario del Caso 17 (handback con datos cargados) y, sin retomar todavía, tener una conversación normal (consultas de menú, horarios) durante un rato.

**Acción:** seguir charlando de temas no relacionados con la reserva.

**Resultado esperado:** en algún momento (respetando presupuesto y cooldown, igual que `COMPLETAR_PEDIDO`), el bot puede ofrecer espontáneamente continuar con la reserva — sin que el cliente tenga que acordarse de pedirlo.

**Qué verifica:** `COMPLETAR_RESERVA` inyectado en `[ESTADO DEL CLIENTE]` del híbrido — la continuidad de reservas ahora está representada, igual que la de pedidos.

---

### Caso 26 — Silenciar la reserva pendiente sin perderla

**Setup:** continuar desde el Caso 20 (bot ya mencionó la reserva pendiente).

**Acción:** "dejalo con la reserva, no me insistas".

**Resultado esperado:** el bot no vuelve a mencionar la reserva pendiente, pero si el cliente la retoma explícitamente más adelante, los datos siguen ahí.

**Qué verifica:** Tool `abandon_pending_reservation` — mismo patrón que `abandon_pending_order`, no borra nada.

---

### Caso 27 — Revival de la reserva al reactivar la sesión

**Setup:** continuar desde el Caso 21 (reserva silenciada).

**Acción:** volver a entrar activamente al flujo de reservas (ej. "quiero reservar" o tocar el botón correspondiente).

**Resultado esperado:** la sesión arranca con los datos previos intactos, y el silencio anterior queda sin efecto — si más adelante se vuelve a interrumpir con `handback_reservation`, el Goal puede volver a plantearse desde cero (presupuesto reseteado).

**Qué verifica:** revival automático al reactivar `reservation_agent_active` (ADR-0005, corolario), simétrico al del carrito.

---

## Dominio: Arbitraje entre Goals simultáneos (ADR-0009)

### Caso 28 — Carrito y reserva pendientes a la vez: solo se menciona uno

**Setup:** provocar a la vez (a) un pedido pendiente con permiso disponible (Caso 6) y (b) una reserva pendiente con permiso disponible (Caso 20), en la misma conversación.

**Acción:** una charla lateral que dé pie a que el sistema podría plantear cualquiera de los dos.

**Resultado esperado:** el bot menciona **como mucho uno** de los dos objetivos en el turno — nunca los dos a la vez. Si hay que elegir, debería priorizar el pedido (pago pendiente) sobre la reserva.

**Qué verifica:** el arbitraje de saliencia en `reactAgent.ts` — la regla "un solo Intent activo por turno" (ADR-0009), que autochequeamos y corregimos durante la Fase 1b porque el primer borrador no la respetaba.

---

## Checklist rápido antes de dar por buena la ronda

**Prioridad alta (bugs de seguridad/dinero, no pueden fallar):**
- [ ] Caso 1 (confirmación de eliminación)
- [ ] Caso 3 (escalamiento dentro de checkout)
- [ ] Caso 15 (no saltear pasos de checkout)
- [ ] Caso 17 y 18 (no se cobra al elegir método; confirmar sí crea la orden)

**Prioridad media (continuidad, el corazón de esta migración):**
- [ ] Caso 6 (retoma el pedido)
- [ ] Caso 9 y 10 (abandono + revival del pedido)
- [ ] Caso 14 (resume correcto tras interrupción en checkout)
- [ ] Caso 19 y 20 (cancelar conserva datos; confirmación por texto libre)
- [ ] Caso 22 y 23 (handback + retomar reserva)
- [ ] Caso 28 (arbitraje — no menciona dos Goals a la vez)

**Prioridad baja (casos de borde, difíciles de reproducir en tiempo real):**
- [ ] Caso 7 y 8 (presupuesto y cooldown — requieren esperar o revisar logs)
- [ ] Caso 5 (falso positivo de escalamiento)
- [ ] Caso 21 (interrupción durante la confirmación final)
- [ ] Caso 24 (abandono definitivo de reserva vs. handback)

Los casos 2, 4, 11, 12, 13, 16, 26, 27 son variantes/confirmaciones de menor riesgo — priorizar los de arriba si el tiempo es limitado.
