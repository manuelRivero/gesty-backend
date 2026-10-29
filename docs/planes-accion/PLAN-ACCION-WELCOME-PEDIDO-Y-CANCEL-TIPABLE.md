# PLAN-ACCION: Welcome "Hacer pedido" + cancel tipable

## Problema

1. El mensaje de bienvenida promete "hacer un pedido" en el copy, pero los atajos tipables/botones solo incluían Menú / Horarios / Consulta / Reservar / Editar dirección.
2. Al desambiguar cancelar (carrito vs pedido confirmado), tipar "Carrito" no tenía el mismo efecto que el botón: tipables viejos (`VIEW_CART → present_cart`) competían y el modelo podía responder prosa inventada sin llamar `cancel_order`.

## Decisiones

| Tema | Decisión |
|------|----------|
| Atajo "Hacer un pedido" | Payload `ORDER_FOOD` en el welcome; tipable en ledger; **sin handler determinístico**. El botón se convierte en texto fresco ("Quiero hacer un pedido") y entra al NLP/híbrido. |
| Party size | Lo pide el ReAct vía Goal / `save_party_size` (mismo flujo que `ORDER_FOOD` en prosa). |
| Cancel tipable | Ledger `CANCEL_TARGET_DRAFT` / `CANCEL_TARGET_ORDER` al desambiguar (pisa tipables previos). |
| Guard | Si `pending_cancel_disambiguation` está activo y el ReAct **no** llamó `cancel_order`, re-mostrar el interactivo de desambiguación (no prosa). Escape permitido: reserva / checkout / address edit / human support. |

## Implementación

- `src/services/smallTalk.service.ts` — fila + bullet `ORDER_FOOD`
- `src/services/pendingTipables.service.ts` — acciones `ORDER_FOOD`, `CANCEL_TARGET_*`
- `src/graph/nodes/dispatch/index.ts` — `ORDER_FOOD` → `nlpSubgraphNode` con entrada sanitizada
- `src/services/order.service.ts` — tipables en desambiguación; export `buildCancelDisambiguationMessage`
- `src/agents/reactAgent.ts` — guard `cancel_disambiguation_guard`

## Repos

1. **gesty-backend** (primero, donde se prueba)
2. **food-service-agent** (espejo)

## Feature

`BOT-01` en `docs/FEATURES.md`.
