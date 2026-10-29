# Pendings tipables — autonomía del agente

**Estado:** normativo para el bot híbrido WhatsApp.  
**Regla Cursor:** `.cursor/rules/hybrid-pending-autonomy.mdc` (`alwaysApply`).

## Problema que resuelve

Los agentes de implementación tienden a “cerrar” tipables con regex / `tryHandle*Hybrid` antes del ReAct. Eso:

- funciona en el caso feliz (“2”, “Roquefort”),
- falla con prosa real (“ponele el picante pero sin cebolla”),
- saltea tools (cantidad, notas, closed-order),
- y se reintroduce en cada PR porque “es más barato que el LLM”.

## Patrón obligatorio

```
mensaje tipable
  → ReAct lee [ESTADO DEL CLIENTE] (ledger pending*)
  → tool (add_cart_item / clear_pending_* / update_item_note / …)
  → gate duro en la tool (no escribe si falta dato / opción inválida)
```

| Pending | Ledger | Confirma | Cancela | Gate duro |
|---------|--------|----------|---------|-----------|
| Gestión (Menú, Nota, …) | `pendingTipables` | tools/señales UI | — | según tool |
| Nota por ítem | `pendingItemNote` | `update_item_note` | `clear_pending_item_note` | ítem en carrito **en la tool**; entrada con `start_item_note` / payload `ITEM_NOTE` |
| Variación | `pendingVariation` | `add_cart_item(variation=)` | `clear_pending_variation` | `matchVariation` **en la tool**; si la prosa no está en el catálogo → aclarar opciones del plato, no buscar otro SKU |
| Cantidad | `pendingAddQuantity` | `add_cart_item(quantity=)` | `clear_pending_add_quantity` | `quantity_required` si suggested ≥ 2 sin qty |
| Cola de líneas de pedido (multi-plato en un mensaje) | `pendingOrderLines` | `continue_order_line` (activa la próxima) / `add_cart_item` en la línea activa (avanza solo) | `cancel_order_line` (una línea) / `clear_pending_order_lines` (todo el resto) | Alta solo por `plan_order_lines` (ReAct, ≥2 hints); avance de línea y supresión de `COMPLETAR_PEDIDO`/`SUGERIR_COMPLEMENTO` mientras haya cola abierta, en el código (`pendingOrderLines.service`, no el modelo) |
| Checkout tipables (fulfillment texto, address, name) | `Paso actual` / Goal en `[ESTADO DEL CHECKOUT]` | `save_fulfillment_type` / `save_delivery_address` / `save_customer_name` | — | `save_payment_method` no escribe si `nextCheckoutStep !== payment` (`*_required`); UI cerrada = `present_*` + nodo por step |
| Onboarding (dirección texto/pin) | `Paso actual` / Goal en `[ESTADO DEL ONBOARDING]` (`nextOnboardingStep`) | `check_address_coverage` (staging) → `resolve_address_confirmation` / botón `ONBOARDING_CONFIRM_ADDRESS` | `ONBOARDING_EDIT_ADDRESS` | no persiste `customer_address` sin confirmación explícita (solo `temp_*` staged); UI cerrada = botones Confirmar/Editar adjuntados por el nodo según Fact staged |
| Reservas (horario + personas + confirmación + ambiente) | `Paso actual` / `Acción esperada` + catálogo de slots/ambientes en `[ESTADO DE LA RESERVA]` (`nextReservationStep`) | Nodo §3.11: `extractSelectSlotPending` / `extractPartySizePending` / `extractConfirmReservationPending` / `extractSelectEnvironmentPending` fulfilled → mismo efecto que `RESERVATION_SLOT:*`, `save_reservation_party_size`, `RESERVATION_CONFIRM`/`CANCEL` y `RESERVATION_ENV:*` (antes del ReAct). Fallback ReAct: `save_reservation_slot` / `save_reservation_party_size` / `resolve_reservation_confirmation` / `save_reservation_environment` | `confirmed: false` o `RESERVATION_CANCEL`; ambiente `null` = sin preferencia | `save_reservation_date`/`save_reservation_party_size`/`save_reservation_slot` no persisten si el gate falla (`invalid_date`/`past_date`/`party_size_too_large`/`invalid_slot`); fuera de catálogo → aclarar + re-mostrar lista (no salto silencioso); todo write mergea vía `patchReservationDraft`; UI cerrada = lista de horarios / tarjeta de confirmación adjuntada por el nodo según paso |

Checkout tipables: **no** hay `tryHandle*Hybrid` pre-ReAct; ver `PLAN-ACCION-CHECKOUT-AUTONOMIA-POLICY.md` y V-29.
Onboarding: mismo criterio, sin matcher pre-ReAct ni `isLikelyAddress` en el camino vivo; ver `PLAN-ACCION-ONBOARDING-AUTONOMIA.md` y V-30/V-31/V-32.
Reservas: mismo criterio; ver `PLAN-ACCION-RESERVAS-AUTONOMIA.md` y V-35/V-36/V-37.

## Excepciones (determinismo OK)

- Handlers de **payload** WhatsApp (`ADD_ITEM:…`, listas).
- Validación de **argumentos de tool** contra catálogo.
- Gates de sesión (horario cerrado, onboarding; party-size *ask* solo en ruta legacy no híbrida).

En hybrid, el ask de party size es **Goal** `OBTENER_PERSONAS_DEL_PEDIDO` (ReAct + `save_party_size`), no Ownership `awaitingPartySize`. Ver `PLAN-ACCION-PARTY-SIZE-GOAL.md`.

No confundir “validar el string que pasó el modelo a la tool” con “parsear el mensaje del usuario con regex antes del agente”.
