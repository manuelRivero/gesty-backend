# ADR-0014 — Un gate resuelve la precondición y no consume la intención que bloqueó

**Estado:** Aceptado · **Fecha:** 2026-09-27

## Contexto

Una tool de pedido (`search_products`, `find_products_by_filter`, `plan_order_lines`, `add_cart_item`) puede recibir la comida del cliente y frenar porque todavía no hay personas. La precondición es el número. La intención sigue siendo el pedido.

Esa comida queda en `conversation_state.metadata.pendingPartySizeOrder`. Si `save_party_size` la borra al guardar el número, el turno siguiente —sin el historial de “quiero ceviche y lomo”— ya no tiene la comida. Resolver la precondición y consumir la intención eran el mismo paso.

El historial de 12 mensajes no es la fuente de recuperación. Si la intención solo vive ahí, se pierde cuando ese hilo no llega.

## Decisión

**Un gate puede resolver una precondición, pero no debe consumir la intención que estaba bloqueando. Una intención pendiente solo se elimina cuando fue transferida a otra representación persistente del estado, cancelada explícitamente o reemplazada por una nueva intención.**

**Los gates controlan si una acción puede ejecutarse; no son dueños del lifecycle de la intención que bloquean. La resolución de una precondición no implica que la intención haya sido satisfecha.**

El ciclo de `pendingPartySizeOrder`:

```text
BLOCKED
  ↓
PENDING
  ↓
PRECONDITION RESOLVED
  ↓
PENDING REMAINS
  ↓
HANDOFF / CANCEL / REPLACE
  ↓
PENDING CLEARED
```

`HANDOFF` es haber transferido la intención a otra representación persistente que alcanza para continuarla.

En este caso:

- `save_party_size` escribe las personas y deja el pending.
- `plan_order_lines` que persiste `pendingOrderLines` es handoff: la cola conserva platos y cantidades. Ahí se limpia.
- `add_cart_item` que escribe el carrito es handoff. Ahí se limpia.
- Un resultado de búsqueda no es handoff. Varios ceviches siguen sin elegir.
- `variation_required` tampoco. `pendingVariation` es un solo plato y no representa el pedido que estaba en espera.
- Cancelar el pedido lo limpia, con el resto de la sesión.
- Un `lookup` de otro turno reemplaza un `lookup` anterior. En el mismo turno los lookups se suman y un `plan` pisa a un `lookup`. El último `plan` pisa al plan anterior. El cruce de turno usa `turnStartedAt`, no el texto del cliente.

El pending tiene que sobrevivir al turno en que se resuelve la precondición. El bloque `[ESTADO DEL CLIENTE]` lo muestra también cuando las personas ya están guardadas.

No se generaliza a un tipo `PendingIntent` ni a un nodo de resume. El mecanismo sigue siendo este pending.

## Consecuencias

**Se gana:**

- El pedido bloqueado se recupera del estado, sin el mensaje original.
- Personas guardadas e intención pendiente son hechos distintos.
- El ciclo del pending queda explícito: handoff, cancelación o reemplazo.
- La precedencia `plan` sobre `lookup` no depende de qué patch termine último, porque la escritura de este pending se encola por conversación en el proceso del turno.

**Se pierde:**

- El pending puede vivir más de un turno después del número.
- Hay que nombrar el handoff. Una búsqueda no lo es.
- Un `lookup` de un turno nuevo no pisa un `plan` de un turno anterior. Lo pisa otro `plan_order_lines`, o el cancel.

**Queda prohibido:**

- Borrar `pendingPartySizeOrder` dentro de `save_party_size`.
- Tratar un resultado de búsqueda como intención consumida.
- Recuperar esta intención solo desde el historial.

## Alternativas descartadas

- Sacar o recortar el historial para que no reinyecte el pedido. El estado tenía que guardar la comida; el historial no era el arreglo.
- Hacer que `save_party_size` llame `plan_order_lines`, `search_products` o `add_cart_item`. El modelo sigue eligiendo la tool. El grafo conserva el dato.
- Un nodo genérico de resume. El nodo de reservas ya reinyecta su propio FAQ; este pending no se convierte en ese nodo.
- Apagar `parallel_tool_calls`. El paralelo se queda. Se serializa solo la escritura de este pending, releyendo la fila dentro de la cola. No se cambia `patchConversationMetadata` ni se usa `SELECT FOR UPDATE` para todos los patches.
- Regex sobre “mejor quiero” para detectar un cambio de plato. El límite es el turno (`turnStartedAt`).
- Un framework `PendingIntent` para todos los gates. La regla queda en este ADR. El código sigue siendo `pendingPartySizeOrder`.
