# Pruebas E2E

Flujos multi-turno contra **BD real + LLM real** (via LangGraph `mainGraph`).
No envían WhatsApp (`DRY_RUN_WHATSAPP_SEND=true`).

## Requisitos

Variables en `.env`:

| Variable | Uso |
|----------|-----|
| `E2E_RUN=1` | Opt-in explícito (lo setean los scripts `npm run test:e2e*`) |
| `DATABASE_URL` | Postgres con negocio y menú de prueba |
| `PHONE_NUMBER_ID` | `whatsapp_phone_id` del negocio |
| `OPENAI_API_KEY` | Agente híbrido / NLP |
| `WHATSAPP_TEST_TO` | Teléfono del cliente de prueba (default `5493413867990`) |

El menú debe incluir al menos un producto relacionado con **ceviche**.

## Entorno reproducible

Cada `resetE2eCustomer()` fija en BD (para el negocio de `PHONE_NUMBER_ID`):

- `bot_personality_id` → personalidad **neutral** (Mozo neutro)
- `humanize_messages` → **false**
- Limpia onboarding (`onboarding_step`, `temp_address`, etc.) y nombre cliente → `E2E Test`
- `peopleCount` / `requestedPartySize` → `2`
- `closed_order_confirmed_at` → ahora (si el local está cerrado pero opera, el gate de ADD_ITEM no vuelve a pedir confirmación)

Así los E2E no dependen de la config del panel admin ni del tono del LLM.

Helpers de carrito:

- `findE2eAddableProduct` — prefiere ceviche **sin variaciones** y sin gate de cantidad (con party=2)
- `findE2eProductWithVariations` / `findE2eQuantityGateProduct` — productos que **disparan** esos gates (Fase 2)
- `addItemViaButtonHappyPath` — ADD_ITEM + variación (`list_reply`) + cantidad + confirm de cerrado si hace falta
- `resetE2eCustomer({ confirmClosedOrder: false })` — para ejercitar el diálogo de local cerrado
- `forceBusinessClosedForE2e` — fuerza horario cerrado con restore (independiente del reloj)

## Filosofía de aserciones

Los tests validan **efectos y estructura**, no frases literales del bot:

| Preferir | Evitar |
|----------|--------|
| metadata (`peopleCount`, `awaitingPartySize`, `checkout_active`, `lastOffer`) | `"agreg"`, `"cuántas personas"`, etc. |
| carrito / `draft_order` | nombres de platos en el texto (`"ceviche"`, `"tiradito"`) |
| `followUps` (`list`, `interactive`), `isInteractive` | copy reescrito por humanize |

Helpers en `graphHarness.ts`: `pinE2eBusinessConfig`, `getFreshConversationMetadata`, `isPartySizeGatePending`, `isPartySizeUnset`, `looksLikeMenuResume`, `hasHandlerResponse`, etc.

En modo híbrido el agente puede pedir party size en texto sin setear `awaitingPartySize` / `peopleCountResume`; los tests validan `peopleCount` persistido, no solo el gate en metadata.

Nota: algunos nodos (p. ej. checkout) persisten metadata en BD sin devolver `workingConversationState` actualizado; usar `getFreshConversationMetadata(conversationId)` en esos casos.

## Ejecutar

Los E2E usan `vitest.e2e.config.ts` (no el config unitario): `fileParallelism: false` porque todos comparten el mismo cliente/conversación en BD.

```bash
# Toda la suite e2e (archivos en serie)
npm run test:e2e

# Un flujo
npm run test:last-offer
npm run test:party-checkout-flow
npm run test:checkout-flow
npm run test:agent-history
npm run test:agent-gates
npm run test:language-variations
npm run test:natural-conversations
```

Si faltan variables, los tests se **saltan** (no fallan) y un test documenta el motivo.

## Suites

| Archivo | Qué valida |
|---------|------------|
| `last-offer-add-item.e2e.test.ts` | `lastOffer` + "Agrega uno" → ítem en carrito |
| `party-checkout-flow.e2e.test.ts` | Party size → menú → checkout → fulfillment |
| `checkout-flow.e2e.test.ts` | ADD_ITEM, CHECKOUT botón/texto, fulfillment |
| `agent-history.e2e.test.ts` | Historial conversacional real inyectado a los agentes (`buildAgentHistoryMessages`) |
| `agent-gates.e2e.test.ts` | Fase 2: variación, cantidad, local cerrado, carrito vacío, Order |
| `language-variations.e2e.test.ts` | Fase 3: misma intención con formulaciones distintas de WhatsApp → mismo efecto |
| `natural-conversations.e2e.test.ts` | Fase 4: micro-conversaciones multi-turno (corrección, interrupción, referencia, continuidad) |

## Helpers

- `e2e/helpers/env.ts` — flags y detección de entorno
- `e2e/helpers/graphHarness.ts` — payloads WhatsApp, `mainGraph`, reset de cliente, `findE2eSecondAddableProduct`, `getActiveDraftFulfillmentType`, `countUserMessages`

## Parity (backend vs agent)

Los tests de paridad 1:1 siguen en `scripts/parity/` (`npm run parity:run`).
