# Implementación: cierre coherente de estado operativo de pedidos + reset E2E verificable

Implementación acotada de las Fases 1 y 2 de
[AUDITORIA-CICLO-VIDA-ESTADO-OPERATIVO.md](AUDITORIA-CICLO-VIDA-ESTADO-OPERATIVO.md). El job
legacy de expiración (`src/workers/draftOrders.ts`) **no se tocó** — queda fuera de alcance por
decisión explícita (será reemplazado por el cierre de turno por business).

## Archivos modificados y responsabilidad de cada cambio

| Archivo | Responsabilidad del cambio |
|---|---|
| `src/services/humanIntentReconciliation.service.ts` | Nueva `closeOrderDomainHumanIntents({conversationId, reason, reference?})`: cierra de forma idempotente todo `HumanIntentRecord` ACTIVE/PENDING de dominio pedido (`PEDIR`, `GESTIONAR_PEDIDO`, `COMPLETAR_COMPRA`, `CANCELAR_COMPRA`), usando las funciones ya existentes y seguras (`cancelHumanIntent`/`resolveActiveHumanIntent`), nunca un borrado crudo de metadata. |
| `src/services/productResolution.service.ts` | Nueva `expireOpenProductResolutions(conversationId)`: expira (pone `expiresAt` en el pasado) toda `ProductResolution` no `consumed`; nunca borra el array ni toca las `consumed`. |
| `src/services/order.service.ts` | `buildCancelOrderMessage` llama a las dos funciones anteriores en los dos puntos donde ya invoca `clearOrderSessionAfterCancel` (cancelación real y el wipe preventivo "nada para cancelar"). No se tocó `orderSessionReset.service.ts` ni `clearOrderSessionAfterCancel` — ese archivo lo comparte el job legacy, y modificarlo habría cambiado el comportamiento del job sin que el encargo lo autorizara. |
| `src/services/checkout.service.ts` | Nueva `reconcileOrderDomainStateAfterCheckout(conversationId, orderId)`, exportada: cierra `humanIntentState` (reason `'completed'`), `pendingOrderLines` (`clearPendingOrderLines`) y `productResolutions` (`expireOpenProductResolutions`) tras un checkout confirmado. Se invoca solo en la rama de `createOrderFromDraft` que gestiona su propia transacción (`!tx`), **después** de que esa transacción resolvió — nunca dentro de una transacción todavía abierta. |
| `src/services/payment/payment.service.ts` | `handleApprovedPayment` (pago online, pasa su propio `tx` a `createOrderFromDraft`) llama a `reconcileOrderDomainStateAfterCheckout` explícitamente, después de que SU transacción externa ya resolvió. |
| `e2e/helpers/graphHarness.ts` | `resetE2eCustomer` se descompuso en `resetTestCustomerOperationalState` (guard + manifiesto + limpieza + verificación posterior, sin tocar historial) + `purgeTestCustomerHistory` (explícita, separada). `resetE2eCustomer` queda como alias de compatibilidad que llama solo a la primera. |
| `src/services/__tests__/closeOrderDomainHumanIntents.test.ts` (nuevo) | Pruebas deterministas contra el `humanIntentState.service` real (no mockeado) de las invariantes 1/2/3/4/5. |
| `src/services/__tests__/orderCancel.service.test.ts` | Mocks + aserciones nuevas: `closeOrderDomainHumanIntents`/`expireOpenProductResolutions` se llaman exactamente en las ramas donde se cancela algo, con la `reference` correcta, y NO se llaman cuando el draft sigue vivo o solo se está desambiguando. Agrega test de idempotencia (cancelar dos veces). |
| `src/services/__tests__/productResolution.service.test.ts` | Tests de `expireOpenProductResolutions`: expira no-consumidas, preserva consumidas, idempotente, no escribe nada si no hay resoluciones. |
| `src/services/__tests__/createOrderFromDraftIdempotency.test.ts`, `src/services/__tests__/checkoutAmbassador.test.ts`, `src/services/payment/__tests__/handleApprovedPayment.test.ts` | Mocks ampliados (el nuevo código real que estos tests ejercitan necesita `conversation_state.upsert`/`$queryRaw` y `omitConversationMetadataKeys` en el barrel de repositorios) + aserciones nuevas sobre cuándo se llama (o no) `reconcileOrderDomainStateAfterCheckout`, incluida la invariante de atomicidad (con `tx` externo todavía abierto, nunca se llama desde adentro). |

## Causa raíz verificada de cada fallo corregido

1. **Cancelación de pedido no invalidaba `humanIntentState`.** `buildCancelOrderMessage` (único punto
   real de cancelación — confirmado de nuevo en el código actual, no asumido de la auditoría previa:
   las 3 rutas — botón, tool `cancel_order`, comando de dominio en prosa — convergen ahí) llamaba a
   `clearOrderSessionAfterCancel`, que limpia `ORDER_SESSION_OMIT_KEYS`/`ORDER_LEDGER_KEYS` pero
   nunca invoca `humanIntentState.service`. Confirmado leyendo `cancelHumanIntent`/
   `resolveActiveHumanIntent`/`requireOpenIntent` (humanIntentState.service.ts): existen y son
   seguras (lock transaccional, revisión de invariantes), simplemente nadie las llamaba desde ahí.
2. **Checkout completado no invalidaba nada del dominio de armado.** Confirmado leyendo
   `createOrderFromDraftLocked` completo (checkout.service.ts): solo limpia `ambassador_ref`. De
   los 3 callers reales (`buildUnpaidCheckoutResult` en checkout.service.ts, el flujo admin en
   `adminOrderConfirmationWebhook.service.ts`, y el pago online en `payment.service.ts`), solo el
   primero cierra la conversación entera después (`closeConversation`, que sí hace `metadata: {}`)
   — los otros dos no tocan `humanIntentState`/`pendingOrderLines`/`productResolutions` en absoluto.
3. **`resetE2eCustomer` borraba todo el historial de mensajes incondicionalmente** y no reportaba ni
   verificaba nada antes de habilitar el escenario siguiente — confirmado leyendo la función
   completa en `graphHarness.ts`.

## Invariantes cubiertas por las pruebas

- `closeOrderDomainHumanIntents`: un `PEDIR` ACTIVE o PENDING con `request.products` queda
  `CANCELLED` tras cerrar por cancelación; un `COMPLETAR_COMPRA` ACTIVE queda `RESOLVED` (no
  `CANCELLED`) tras cerrar por checkout completado; un intent de otro dominio (`RESERVAR`) nunca
  termina `CANCELLED`/`REPLACED`; una segunda llamada no lanza y no cambia el estado (idempotencia).
- `expireOpenProductResolutions`: las no-`consumed` quedan expiradas (ya no autorizan un
  `consumeProductResolution` posterior); las `consumed` no se tocan; sin resoluciones, no escribe
  nada; idempotente.
- `order.service.ts`/`checkout.service.ts`/`payment.service.ts`: las funciones nuevas se llaman
  exactamente en las ramas correctas (con la `reference` correcta) y **no** se llaman cuando no
  corresponde (draft vivo, desambiguación sin decidir, `tx` externo todavía sin commitear).
- Atomicidad: demostrado con mocks que, si `createOrderFromDraft` recibe un `tx` externo, el cierre
  del estado conversacional NUNCA ocurre dentro de esa llamada — es responsabilidad explícita del
  caller (`payment.service.ts`) invocarlo después de que su propia transacción resolvió.

## Comandos ejecutados y resultados reales

```
npx tsc --noEmit -p .                         → sin errores
npx vitest run                                 → 219 test files passed | 1 skipped
                                                  1942 tests passed | 3 skipped (preexistentes)
```

**Suites NO ejecutadas, explícitamente:** ninguna suite de `e2e/*.e2e.test.ts` (incluida
`reset-e2e-customer-isolation.e2e.test.ts`, que ejercita directamente `resetTestCustomerOperationalState`
contra Postgres real). Requieren `E2E_RUN=1` contra la base y el número de WhatsApp compartidos de
desarrollo — correrlas estaba explícitamente prohibido para esta tarea ("no ejecutar pruebas reales
destructivas en el número de WhatsApp compartido"). Esto es un riesgo real, no solo una formalidad:
el cambio de comportamiento de `resetE2eCustomer` (ya no purga `conversation_message` por defecto)
nunca se verificó corriendo el E2E real.

## Confirmaciones explícitas pedidas

- **El historial no se borra en el reset habitual**: `resetTestCustomerOperationalState` no llama a
  `conversation_message.deleteMany` en ningún punto; esa operación vive únicamente en
  `purgeTestCustomerHistory`, que además exige `isE2eEnabled()` antes de borrar algo. Verificado
  también por tipo (ningún import de `prisma` cruza esa función con la de purga) y por lectura
  completa del archivo tras el cambio.
- **Los pedidos confirmados se preservan**: ni `resetTestCustomerOperationalState` ni
  `closeOrderDomainHumanIntents`/`expireOpenProductResolutions` escriben nunca en la tabla `orders`.
  El reset solo los lee (para el manifiesto) y los incluye en la verificación posterior (si su
  cantidad cambia, el reset falla con un error explícito en vez de continuar).
- **El job legacy no se modificó**: `git diff src/workers/draftOrders.ts` no muestra ningún cambio;
  `orderSessionReset.service.ts` (que el job sigue llamando sin modificaciones) tampoco se tocó.

## Riesgos y límites pendientes (no resueltos a propósito)

- **Carrera job-atrasado-vs-pedido-nuevo (Fase 7.2 de la auditoría): NO resuelta.** No se puede
  afirmar que esté resuelta porque, tal como pide el encargo, no se avanzó la refactorización de
  asociar `humanIntentState`/`pendingOrderLines` a un `draftOrderId`/`orderId` explícito (cambio de
  convención/esquema fuera de alcance de esta tarea) — y el job que tiene esa carrera está
  explícitamente fuera de alcance. Este fix cierra el estado tras cancelar/completar en el flujo
  real de **producción**; no toca ni mitiga el camino del job.
- **`resetE2eCustomer` ahora exige `isE2eEnabled()` dentro de la función misma** (antes dependía
  solo del `describe.skipIf` de cada archivo de test) — cierra el gap documentado en la Fase 5 de la
  auditoría, pero sigue sin existir un flag de "negocio/cliente de test" a nivel de DB: la garantía
  de que el E2E nunca toque datos reales sigue dependiendo de qué `DATABASE_URL`/`PHONE_NUMBER_ID`
  resuelva `.env*` en la máquina donde corra.
- **Cambio de comportamiento no verificado en vivo**: los ~15 archivos `e2e/*.e2e.test.ts` que
  llaman `resetE2eCustomer()` ahora arrancan cada escenario con el historial de mensajes de la
  corrida anterior todavía presente (antes se borraba). Por análisis estático (grep de
  `conversation_message`/conteos de mensajes/aserciones de longitud de historial en los ~15
  archivos) no se encontró ninguna aserción que dependa explícitamente de un historial vacío, pero
  esto **no reemplaza correr el E2E real** — en particular `agent-history.e2e.test.ts`, cuyo
  comentario original (ya removido del código) fue precisamente el que motivó el borrado
  incondicional ("rompen aserciones de agent-history"). Recomendado: correr
  `E2E_RUN=1 npx vitest run -c vitest.e2e.config.ts` en un entorno de desarrollo aislado antes de
  mergear, prestando atención particular a ese archivo.
- **`productResolutions` expiradas, no borradas**: el array sigue creciendo hasta el cap de 200; no
  se tocó ese comportamiento (no estaba roto, solo evaluado).
