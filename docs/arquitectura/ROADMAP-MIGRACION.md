# Roadmap de migración

**Estado:** vivo. **Referencia:** [`ARQUITECTURA.md`](../../ARQUITECTURA.md) · [`TAXONOMIA.md`](TAXONOMIA.md) · [`VIOLACIONES.md`](VIOLACIONES.md) · [ADR-0013](../adr/0013-migracion-sin-downtime.md)

**Restricción rectora:** el sistema está en producción con clientes reales. **Ninguna fase cambia una respuesta al usuario hasta que la anterior esté medida en producción.** Toda fase es un feature flag independiente con kill switch.

**Ciclo obligatorio por cada campo migrado** (ADR-0013):
`shadow → dual-write → shadow-read → flip (canary) → cleanup`. **Un campo por PR.**

---

## Fase −1 — Precondiciones · **no dependen del Goal Engine**

Se hacen **primero** y en paralelo. Son huecos de seguridad, no de arquitectura, y no deben esperar cinco fases.

| Tarea | Violación | Por qué va primero |
|---|---|---|
| ~~Confirmación exigida en la Tool de eliminación~~ | ~~V-01~~ ✅ | El Constraint no existía: existía su intención |
| ~~Detector determinista de escalamiento a humano~~ | ~~V-02~~ ✅ | Un cliente furioso en checkout dependía de que el LLM decida delegar |

> ~~Reserva pausada bloquea el routing (V-03)~~, ~~worker de expiración arrasa el estado ajeno (V-04)~~, ~~V-01~~ y ~~V-02~~ — **las cuatro ya corregidas**, verificado en código. Ver [`VIOLACIONES.md`](VIOLACIONES.md#historial-de-correcciones).

**Puerta:** V-01 y V-02 cerradas. ✅ **Fase −1 completa — lista para Fase 0.**

---

## Fase 0 — `COMPLETAR_PEDIDO`

> **Un solo Goal. Un solo agente (el conversacional). Cero cambios en routing, checkout, reservas u onboarding.**

**Corrige:** V-07 — la continuidad no está representada.

**Estado (2026-07-12): implementada completa, sin shadow.** Decisión explícita del usuario: esta rama todavía no tiene tráfico real de producción, así que la semana de shadow (que existe para medir contra tráfico real antes de arriesgar UX) no aporta nada — se construyó directo con inyección activa, sin feature flag, para poder probarla conversando con el bot ya mismo. **Cuando esto se despliegue a producción real, correr un shadow/canary corto ahí sí tiene sentido** — pero esa es una decisión para ese momento, documentada acá para no perder el motivo del atajo.

### Alcance
- ✅ Proyector de Facts del pedido — reutiliza la query existente en `reactAgent.ts` (`buildContextMessage`), no se agregó una nueva.
- ✅ Derivador puro de `COMPLETAR_PEDIDO`: `src/services/orderCompletionGoal.service.ts` (`deriveOrderCompletionGoal`). Abierto ⟺ hay ítems ∧ no arrancó el checkout ∧ no fue abandonado.
- ✅ Ledger mínimo: **`abandonment`** + **`surfaceCount`** (+ `lastSurfacedAt` para el cooldown), persistidos en `conversation_state.metadata.intentLedger.COMPLETAR_PEDIDO` — únicos datos persistidos de la fase (ADR-0005). Migración a tabla propia queda para Fase 2, Bloque E.
- ✅ Selector de permiso (`computeOrderCompletionPermission`: presupuesto 3 + cooldown 10 min) + inyección de una línea en `[ESTADO DEL CLIENTE]` cuando hay permiso.
- ✅ Tool `abandon_pending_order` (`src/tools/index.ts`) — **no borra el carrito**, registra que no hay que insistir.
- ✅ Revival (ADR-0005, corolario): `add_cart_item` limpia el abandono si el cliente agrega otro ítem.
- ✅ Logging del Ledger en cada turno (`[goal] order_completion_ledger`), incondicional — corre aunque no haya permiso.
- ⬜ Métrica de línea base (turnos con Goal abierto que nunca se planteó) — no se midió; no aplica sin tráfico real. Si esto llega a producción, medirla ahí antes de un canary amplio.

Tests: `src/services/__tests__/orderCompletionGoal.service.test.ts` (derivador + permiso + I/O).

### (Texto original del plan — semana de shadow, no ejecutada en esta rama)

Todo corriendo, **logueando**. Nada inyectado. Ninguna respuesta cambia.

**Métrica de línea base — la que justifica o mata el proyecto entero:**

> **turnos con Goal abierto que nunca se planteó / turnos con Goal abierto**

**Si sale bajo, el problema era otro y hay que PARAR.** Una semana de trabajo que evita un refactor de meses es el mejor retorno posible. Hace falta disciplina para cruzar esta puerta en las dos direcciones.

### Semana 2+ — Canary 10 → 50 → 100% (referencia para cuando esto vaya a producción real)

| Métrica | Umbral |
|---|---|
| **Tasa de recuperación** (carrito + cambio de tema → llega a checkout) | **Debe subir. Es el KPI.** Si no sube, la fase falló. |
| **Intents planteados por turno** | **> 1.0 → rollback automático** |
| Menciones consecutivas del mismo Intent | > 1 → bug en el cooldown |
| Tasa de abandono explícito | > 5% → el tono es invasivo |
| Uso del permiso | < 20% (tímido) o > 80% (abusivo) → recalibrar |
| Divergencia (plantea sin permiso) | > 5% → endurecer |

### Riesgos específicos
| Riesgo | Mitigación |
|---|---|
| 🔴 **Bot insistente** | Permiso + cooldown + tope 3 + un Intent por turno (ADR-0009). Rollback automático por métrica. |
| 🔴 **Abandono sin revival** | El cliente abandona, arma otro pedido, el bot nunca lo ayuda. **Test explícito de 3 turnos: no se detecta en QA manual.** (ADR-0005) |
| 🔴 **El Goal desplaza la consulta del cliente** | Primacía absoluta de la consulta actual. Eval con casos reales antes del canary. |

**Rollback:** un feature flag. Apagado ⇒ el contexto se genera byte por byte como hoy. **Cero migración de datos que revertir.**

---

## Fase 1 — Goals operativos de checkout

> **Hallazgo:** el derivador **ya existe**. La función pura que deriva el paso del checkout desde los Facts **es** el Goal Engine del checkout (ADR-0006). Esta fase es de **exposición y consolidación**, no de construcción.

**Estado (2026-07-12): completa.**

**Corrige:** V-06, V-08.

### Alcance
- ✅ `DEFINIR_ENTREGA`, `OBTENER_DIRECCION`, `OBTENER_NOMBRE`, `DEFINIR_METODO_DE_PAGO` nombrados y trazados desde `nextCheckoutStep` — `src/services/checkout/checkoutGoal.service.ts` (`checkoutGoalForStep`, `logCheckoutGoal`). Log obligatorio `[goal] checkout_step` en cada turno de checkout (ADR-0007: traza de qué Goal está activo y por qué).
- ✅ **Eliminado el flag de pending persistido** (`checkout_pending_action`/`checkout_pending_question`, sacado de `ConversationMetadata`) ⇒ **el reconciliador desapareció solo**: `src/services/checkout/effectivePending.ts` fue borrado junto con su test. `resolveCheckoutPendingFromStep(step)` deriva la misma información (pending action estructurado + pregunta corta) directamente de `nextCheckoutStep`, sin nada que reconciliar porque no hay una segunda copia.
- ✅ `COMPLETAR_PEDIDO` ya **no muere** al empezar el checkout — **verificado que esto ya funcionaba solo, sin cambios de código**: su derivador (`facts.hasItems && !facts.checkoutActive && !ledger.abandonment`, Fase 0) reabre el Goal automáticamente en cuanto `checkout_active` se limpia (cancelación, handback, o pago fallido) mientras el carrito siga teniendo ítems — es la propiedad estructural de un Goal derivado (ADR-0005): no hay nada que "reaparezca" porque nunca se persistió como cerrado. Tampoco hace falta modelar "presión silenciosa" explícita: mientras el checkout tiene el turno, Ownership (ADR-0001) ya impide que `buildContextMessage` del híbrido — donde se evalúa `COMPLETAR_PEDIDO` — se ejecute siquiera.

### Guardarraíles anti-FSM *(ADR-0006)*
- El **orden** lo sigue determinando la función de orden. **Es un Constraint, no una prioridad de Intents.**
- El ranker pregunta *"¿hay bloqueantes?"* y **delega el desempate**. **No sabe —ni debe saber— que la dirección va antes que el pago.**
- Sin dependencias entre Goals. Sin transiciones. Sin sub-goals.

**Puerta:** ✅ reconciliador borrado · ✅ typecheck + tests verdes (214/222, mismos 8 fallos preexistentes por falta de Postgres de test) · ✅ **paridad verificada contra el bot real (2026-07-12/13)** — varias rondas de pruebas manuales con usuarios reales encontraron y corrigieron bugs concretos (V-16 a V-27 en [`VIOLACIONES.md`](VIOLACIONES.md)); no es "cero bugs encontrados", es "el ciclo de prueba-contra-bot-real-y-corregir se ejecutó y sigue siendo la forma de validar esta fase".

Tests: `src/services/checkout/__tests__/checkoutGoal.service.test.ts`.

---

## Fase 1b — Goals operativos de reservas

> **Mismo hallazgo que en checkout, detectado tarde:** la función que deriva la próxima pregunta del borrador de reserva **ya existe** — `nextReservationDraftQuestion` (`src/graph/nodes/session/buildResumeFollowUp.ts:50`), construida con el mismo patrón que `nextCheckoutStep` en un refactor anterior. Reservas está en la misma posición que estaba checkout antes de su Fase 1: el derivador de orden ya está, falta exponerlo como Goal. **Es exposición, no construcción**, igual que la Fase 1.
>
> **Por qué es una fase propia y no un punto más de la Fase 1:** son dos dominios independientes (checkout vs. reservas), con Facts, Ledger y Tools propios — mezclarlos en un solo PR viola la misma disciplina de "un cambio por PR" que aplica a la migración de flags (ADR-0013). Va inmediatamente después de la Fase 1 porque comparte todo el patrón recién validado ahí (Goal derivado + Ledger + permiso + inyección en `[ESTADO DEL CLIENTE]`), no antes: conviene que el patrón de checkout ya esté probado en producción antes de replicarlo.

**Estado (2026-07-12): completa.**

**Corrige:** V-15 (ver [`VIOLACIONES.md`](VIOLACIONES.md)). Era un hueco no detectado hasta ahora: `COMPLETAR_RESERVA` ya está en el catálogo cerrado (`TAXONOMIA.md` §2) pero ninguna fase del roadmap lo construía.

**Hallazgo durante la implementación — esta fase resultó ser construcción, no solo exposición:** a diferencia del carrito (`draft_order`, tabla propia, Fact independiente de la sesión), `reservation_draft` vive **dentro** de la metadata de sesión. Los cinco puntos de salida del agente de reservas (`clearReservationSession`) borraban `reservation_agent_active` **y** `reservation_draft` juntos, siempre — no existía un equivalente a `handback_to_main` de checkout. Con eso, `COMPLETAR_RESERVA` nunca podría haber estado abierto fuera de la sesión del agente: la condición `!reservationAgentActive` jamás coincidía con `hasDraft`. Se decidió (con el usuario) construir primero la pieza que faltaba.

### Alcance
- ✅ **`handback_reservation`** (`src/tools/reservation.ts`) — nueva Tool de salida temporal del agente de reservas: limpia `reservation_agent_active` pero **conserva** `reservation_draft` (a diferencia de `abandon_reservation`, que borra los dos). Sistema de prompt actualizado (`buildReservationAgentSystemPrompt`) para que el LLM la use cuando el cliente quiere hacer algo fuera de la reserva sin abandonarla (pedir comida, ver el menú). Mismo patrón que `invokeHybridAfterCheckoutHandback`: invoca al híbrido inline en el mismo turno.
- ✅ `COMPLETAR_RESERVA` derivado — `src/services/reservationCompletionGoal.service.ts` (`deriveReservationCompletionGoal`): abierto ⟺ hay un borrador en curso (`hasReservationDraftInProgress`) ∧ el agente de reservas no tiene el turno ∧ no fue abandonado. Reusa `nextReservationDraftQuestion` (exportada de `buildResumeFollowUp.ts`) para nombrar qué falta en el hint inyectado.
- ✅ Ledger propio, mismo patrón que `COMPLETAR_PEDIDO`: `abandonment` + `surfaceCount` + `lastSurfacedAt` en `conversation_state.metadata.intentLedger.COMPLETAR_RESERVA`. **Bug latente corregido en el camino:** `patchConversationMetadata` mergea superficial — escribir `intentLedger` directo desde cada Goal service hubiera pisado la entrada del otro Goal. Nuevo `src/services/intentLedger.repository.ts` (`patchIntentLedgerEntry`) lee el `intentLedger` completo antes de escribir una sola entrada; `orderCompletionGoal.service.ts` se migró al mismo helper.
- ✅ Revival (ADR-0005, corolario): al reactivar la sesión de reservas (`reservation_agent_active` false→true), si había abandono se limpia solo.
- ✅ Tool `abandon_pending_reservation` (hybrid, análoga a `abandon_pending_order`) — no borra el borrador, solo silencia.
- ✅ **Arbitraje de saliencia (ADR-0009), corregido antes de cerrar la fase:** el primer borrador inyectaba `COMPLETAR_PEDIDO` y `COMPLETAR_RESERVA` de forma independiente — si ambos tenían permiso el mismo turno, se mostraban los dos a la vez, violando "un solo Intent activo por turno". `reactAgent.ts` ahora calcula el permiso puro de ambos primero y suprime uno (`suppressedBySaliency`) si los dos ganarían el turno; empate → gana `COMPLETAR_PEDIDO` (un pago pendiente es más urgente que una reserva a futuro).

### Guardarraíles
- El orden de recolección (fecha → horario → personas → ambiente) lo sigue determinando `nextReservationDraftQuestion`. **Es un Constraint del flujo, no una prioridad de Intents** — mismo criterio que en Fase 1.
- Un solo Intent activo por turno: verificado con test explícito (`suppressedBySaliency`), no solo declarado.

**Puerta:** ✅ típecheck + tests verdes (214/222, mismos 8 fallos preexistentes) · ✅ paridad contra el bot real verificada (2026-07-12/13, ver nota en Fase 1) — el flujo de reservas en sí no fue el foco de los bugs encontrados (checkout/onboarding/dirección lo fueron), pero comparte el mismo motor de Goal ya ejercitado · `RESERVA_PROXIMA` (Alert, Fase 3) queda fuera de alcance de esta fase.

Tests: `src/services/__tests__/reservationCompletionGoal.service.test.ts`, casos de arbitraje agregados a ambos `*GoalService.test.ts`.

---

## Fase 2 — Migración de flags

**Un flag por PR.** De menor a mayor riesgo transaccional.

```
BLOQUE A — Opportunities  (si fallan, alguien no ve un banner de postre)
  1. cooldowns de sugerencias        → Ledger
  2. banners ya mostrados            → Ledger
  3. oferta activa                   → Opportunity  (+ arreglar el TTL muerto, V-12)
  4. sugerencia de dirección         → Opportunity  (¡no confundir con el Goal!, V-09)

BLOQUE B — Ledger  (unificación pura, sin cambio de comportamiento)
  5. contadores de rechazo (×2)      → Ledger       (V-10)

BLOQUE C — Goals declarados
  6. tarea interrumpida              → Goal declarado (V-11 — mata las ~7 limpiezas)
  7. desambiguación de producto      → Goal declarado
  8. acciones pendientes por bloqueo → Goal declarado

BLOQUE D — Transaccionales  (últimos, con el engine ya maduro en producción)
  9. pending question del checkout   → ELIMINAR (regenerable desde el renderer)
 10. awaiting_address                → SEPARAR en Ownership + Goal + Opportunity (V-09)
 11. awaiting_name                   → Goal derivado

BLOQUE E — Limpieza
 12. wizard legacy de reservas       → ELIMINAR  (V-14, cierra V-03 definitivamente)
 13. Ledger: del estado de conversación → tabla propia
 14. reglas transaccionales del prompt → borde de las Tools  (V-05)
```

**El bloque A es deliberadamente aburrido.** Su función no es entregar valor: es **ejercitar el engine con riesgo cero antes de darle el checkout.** Si te tienta saltar al bloque D, ese es exactamente el impulso que este roadmap existe para frenar.

**Puerta:** flags ≤ 9 · reconciliadores = 0 · reglas transaccionales en prompts = 0.

---

## Fase 3 — Opportunities y Alerts

Solo después de que la familia Intent lleve **semanas estable** en producción.

| Entrega | Nota |
|---|---|
| `SUGERIR_COMPLEMENTO`, `OFRECER_PROMOCION` | **Presupuesto 1, sin excepciones** (ADR-0008). El mecanismo es idéntico al de un Goal — la legitimidad es opuesta. |
| `NEGOCIO_POR_CERRAR`, `ITEM_SIN_STOCK`, `PEDIDO_POR_EXPIRAR` | Alerts con cierre por emisión |
| `PAGO_RECHAZADO`, `FUERA_DE_COBERTURA` | Alerts que **exigen resolución**: se comportan como Goals bloqueantes |

**Métrica de guardia, sostenida:** Intents planteados por turno ≤ 1.0. **Las Opportunities son la vía más probable de degradar el sistema hacia un bot insistente** — llegan últimas y con el presupuesto más ajustado por diseño.

---

## Cronograma y puertas

| Fase | Duración | Puerta para avanzar |
|---|---|---|
| **−1 — Precondiciones** | 3 días | V-01 y V-02 cerradas |
| **0 — Shadow** | 1 sem | Línea base medida. **Si la pérdida de continuidad es baja → PARAR.** |
| **0 — Canary** | 1 sem | Recuperación ↑ · Intents/turno ≤ 1.0 · abandono < 5% |
| **1 — Checkout** | 1–2 sem | Reconciliadores = 0 · paridad verde |
| **1b — Reservas** | 1 sem | Paridad verde (reusa el patrón validado en Fase 1) |
| **2 — Bloques A/B** | 2 sem | Divergencia ≈ 0 en shadow-read |
| **2 — Bloques C/D** | 3–4 sem | Un flag por PR · paridad verde |
| **2 — Bloque E** | 1–2 sem | Flags ≤ 9 · reglas en prompts = 0 |
| **3 — Opp./Alerts** | 2 sem | Intents/turno ≤ 1.0 sostenido |

---

## Definición de terminado

La migración está completa cuando las tres métricas de salud llegan a su meta **y se sostienen**:

| Métrica | Hoy | Meta |
|---|:-:|:-:|
| Reconciliadores en el código | 1 | **0** |
| Flags en el estado de conversación | ~36 | **≤ 9** |
| Reglas transaccionales solo en prompts | ≥ 4 | **0** |

**Criterio de éxito duro:** si al terminar la Fase 2 el conteo de flags no bajó a un dígito, **no hubo refactor — se agregó una capa encima.** Escribilo en el ticket.
