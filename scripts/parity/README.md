# Parity tests — `food-service-agent` vs `food-service-backend`

Pruebas manuales para validar que el grafo LangGraph nuevo produce **el mismo
`HandlerResult`** que el `processWebhook` original para los mismos inputs.

## Pre-requisitos

1. `food-service-backend` y `food-service-agent` apuntando a la **misma BD
   Postgres** (`DATABASE_URL` idéntico).
2. Las variables `.env` del agente configuradas (`OPENAI_API_KEY`,
   `WHATSAPP_*`, etc.).
3. Un negocio de prueba en la BD con su `whatsapp_phone_id` conocido y un
   cliente con su `phone_number`.

## Cómo correrlo

### 1. Reemplazar placeholders en los payloads

Cada archivo en `payloads/*.json` tiene placeholders:

- `REPLACE_WHATSAPP_PHONE_ID` → el `business.whatsapp_phone_id` del negocio de
  prueba.
- `REPLACE_CUSTOMER_PHONE` → un teléfono real (puede ser tuyo) ya registrado
  como `customer` para ese negocio.
- `REPLACE_PRODUCT_ID` → un `product.id` válido del menú (sólo para
  `interactive-add-item.json`).

> Tip: hacé un fork local con `cp -r payloads payloads.local` y editá ahí; el
> runner acepta paths absolutos como argumento.

### 2. Modo dry-run (recomendado)

El runner setea `DRY_RUN_WHATSAPP_SEND=true` por defecto. En ese modo el
`sendResponseNode` y `persistAIMessageNode` **no envían** a Meta ni persisten
mensajes del bot, sólo logean.

Esto es importante porque algunos payloads (como `text-order-food.json`)
disparan llamadas reales a OpenAI y a la BD, pero **no** dejan basura en la
conversación.

### 3. Ejecutar

```bash
# Todos los payloads
npm run parity:run

# Uno solo
npm run parity:run -- scripts/parity/payloads/text-greeting.json
```

Salida esperada:

```
[parity] running 7 payload(s)

[OK  ] text-greeting.json
       Texto libre: saludo (debería rutear a SMALL_TALK).
       intent=SMALL_TALK earlyExit=- result=TXT|...
```

## Comparar 1:1 contra el backend viejo

El runner sólo ejecuta el lado nuevo. Para comparar contra `processWebhook`
original:

1. En el backend viejo aplicar el mismo flag `DRY_RUN_WHATSAPP_SEND` (parche
   manual: envolver el `WhatsAppSenderService` para que sea no-op cuando esté
   activo).
2. Crear un script paralelo `food-service-backend/scripts/parity/runner.ts`
   que importe `processWebhook` y los mismos JSONs.
3. Diffear los logs (`[SendResponse] Sending response: ...`) lado a lado.

Para fase 1 (paridad determinística), basta con:

- Mismo `intent` detectado por NLP.
- Mismo `handler` matcheado (verificable por `result.content` truncado).
- Mismo `earlyExit`.

## Cobertura actual de payloads

| Payload                       | Tipo        | Intent / Handler esperado |
| ----------------------------- | ----------- | ------------------------- |
| `text-greeting.json`          | text        | `SMALL_TALK`              |
| `text-order-food.json`        | text        | `ORDER_FOOD`              |
| `text-business-hours.json`    | text        | `BUSINESS_HOURS`          |
| `text-reservation.json`       | text        | `RESERVATION`             |
| `interactive-view-menu.json`  | button      | `viewMenu`                |
| `interactive-checkout.json`   | button      | `checkout`                |
| `interactive-add-item.json`   | list_reply  | `addItem`                 |
| `status-only.json`            | status      | early-exit                |

Para cobertura completa de los 35 handlers, agregar un JSON por cada
`payloadId` listado en `src/controllers/webhook/handlers/index.ts` siguiendo
el mismo patrón.
