# Auditoría C — Cocina, comandas y preparación de pedidos en Gesty POS

> Documento de auditoría exclusivamente de lectura/diseño. No se modificó código, schema, datos ni configuración. No se crearon comandas de prueba, no se enviaron notificaciones, no se ejecutó ningún pago ni integración externa.
>
> **Convención de evidencia**: **[HECHO]** comprobado en código/datos actuales, con cita `archivo:línea`. **[DISEÑO]** propuesta arquitectónica para el futuro POS, no implementada. **[PENDIENTE]** decisión funcional/comercial no resuelta, requiere aprobación explícita. **[RECOMENDACIÓN]** sugerencia derivada de la evidencia.
>
> **Documentos de referencia, tratados como ya cerrados y no reabiertos aquí**: `docs/arquitectura/POS_MASTER_SPEC.md` (decisión arquitectónica de `table_tab` como cuenta de salón, y boceto inicial de `kitchen_ticket`/`preparation_station` en su §3.2) y `docs/arquitectura/SABROSON_POS_AUDIT.md` (datos reales de Sabrosón). Esta auditoría **profundiza** ese boceto, no lo reemplaza ni lo contradice salvo donde se señala evidencia nueva explícita.

---

## 1. Resumen ejecutivo

Gesty no tiene hoy absolutamente ninguna infraestructura de cocina. Búsquedas exhaustivas sobre `gesty-backend` y su panel admin hermano `gesty-admin` (Next.js) por kitchen/KDS/comanda/estación/impresora/thermal dan **cero resultados** en ambos repos, y `package.json` de ninguno de los dos tiene dependencias de impresión térmica. `OrderStatus.preparing`/`ready_for_pickup` son, confirmado una vez más con evidencia directa de esquema y código, estados de **pedido completo** del flujo delivery/take-away — nunca estados por producto. `order_item` es inmutable desde su creación (cero `update`/`delete`/`upsert` en todo `src/services/` fuera del carrito) y no tiene columna de estado.

Tres hallazgos nuevos, no documentados con este nivel de detalle en auditorías previas:

1. **[HECHO — bloqueante concreto]** El socket admin existente (`adminSocket.ts:35`) tiene `ADMIN_NOTIFICATION_ROLES = Set(["OWNER","ADMIN"])`: cualquier otro rol se **desconecta inmediatamente** al conectar (`adminSocket.ts:147-153`). Si se agregan roles de mozo/cocina sin tocar esta constante, quedarán excluidos del tiempo real exactamente los roles que más lo necesitan.
2. **[PENDIENTE — brecha de modelo no resuelta]** Un plato que requiere preparación coordinada de dos estaciones físicas (ej. parrilla + guarnición) no tiene solución limpia con el `menu_item_station` N:N bocetado en el master spec — generaría ambigüedad sobre qué estación prepara qué parte. Requeriría una entidad de "componentes" de producto que no está cubierta por el diseño actual.
3. **[DISEÑO, ya con precedente directo en el repo]** El repo ya tiene dos patrones de idempotencia reales y probados — `pg_advisory_xact_lock` (`checkout.service.ts:85-100`) y el claim transaccional `claimInvoiceRow`/`decideFromExisting` (`invoice.service.ts:112-215`) — que deben reutilizarse textualmente para comandas (`@@unique([order_id, station_id])` en `kitchen_ticket`), en vez de inventar un mecanismo nuevo. `handleDraftOrder` (`order.service.ts:399-426`, sin lock) es, en el propio repo, el ejemplo de qué no replicar.

**Decisión de diseño central de esta auditoría**: la generación de `kitchen_ticket`/`kitchen_ticket_item` debe ser **síncrona**, dentro de la misma transacción que confirma la orden/ronda — a diferencia de la facturación electrónica (fire-and-forget post-commit) — porque una orden de salón sin su comanda generada es una falla operativa grave (el cliente ya pagó/pidió y cocina nunca se entera), mientras que una factura demorada no bloquea la operación del salón.

**Mínimo viable para demostrar cocina funcionando en Sabrosón** (ver §16): Fase 3 del master spec (`preparation_station`, `menu_item_station`, `kitchen_ticket`, `kitchen_ticket_item`, con 2-3 estados por producto, no los 5 completos) + un KDS web mínimo (reutilizando Socket.IO + REST de snapshot) — sin impresión térmica, que queda fuera del mínimo viable.

---

## 2. Inventario técnico existente

- [HECHO] Búsqueda exhaustiva (`grep -rniE "kitchen|KDS|comanda|estacion.*cocina|kitchen_station|thermal|printer|print.*ticket|escpos"`) sobre `src/`, `prisma/schema.prisma` y `package.json`/`package-lock.json` de `gesty-backend`: **0 resultados**. Misma búsqueda sobre todo el repo hermano `gesty-admin` (`/home/manuel/PROYECTOS/gesty-admin`, excluyendo `node_modules`/`.next`): **0 resultados**. Único falso positivo: `console-table-printer` en `package-lock.json` (formateo de tablas en consola para debugging, sin relación con impresión térmica).
- [HECHO] `gesty-admin/components/` no tiene ningún directorio de cocina/KDS. `components/tables/` solo contiene el editor de floor-plan (`tables-layout-footer.tsx`); `components/orders/` solo contiene `delivery-assignment-field.tsx` (asignación de repartidor).
- [HECHO] `order_item` (`prisma/schema.prisma:425-440`): columnas reales `id, order_id, menu_item_id, quantity, unit_price, serves_people, created_at, notes, list_price, discount_amount, variation`. Sin `status`, sin relación a estación/impresora.
- [HECHO] Grep de mutaciones (`update|delete|upsert`) sobre `order_item` en todo `src/services/`: **0 resultados**. Todas las mutaciones de línea de pedido encontradas son sobre `draft_order_item` (carrito, antes de checkout): `adminDraftOrder.service.ts:224,278,307`, `cart.service.ts:437,888,1680,1731`, `order.service.ts:176`, `whatsapp.service.ts:678`. Confirmado: una vez creado (pedido confirmado), `order_item` **nunca** se actualiza ni se borra.
- [HECHO] `OrderStatus` (`:1011-1021`) = `draft, placed, preparing, shipped, ready_for_pickup, delivered, cancelled` — enum de orden completa. `FulfillmentType` (`:1024-1027`) = solo `DELIVERY, TAKE_AWAY`. `OrderPaymentStatus` (`:1030-1035`) = binario `unpaid, paid`.
- [HECHO] Máquina de estados: `src/constants/orderWorkflow.ts` define `ORDER_STATUS_PIPELINE`/pipelines por fulfillment (líneas 10-35), `ADMIN_PATCHABLE_ORDER_STATUSES` (38-43) y `getNextOrderStatus()` (58-74). Esta función **no se invoca** en `PATCH /api/admin/orders/:id/status` (`adminOrders.routes.ts:226`) — único endpoint de cambio de estado, a nivel de orden completa, sin endpoint por `order_item`.
- [HECHO] `menu_category.category_tag` (`MenuCategoryTag`: `STARTER/MAIN/SIDE/DRINK/DESSERT/OTHER`) se usa en exactamente dos lugares, ambos comerciales: `src/helpers/complementaryMenu.helper.ts` (sugerencia de combo en WhatsApp) y `src/services/adminMenuItems.service.ts` (filtro de catálogo admin). **No es ni puede reutilizarse como estación de cocina** — confirmado por ausencia total de otro consumidor.
- [HECHO] `menu_item.preparation` es texto libre (receta/instrucciones para IA/presentación); no aparece en `orderWorkflow.ts` ni en ningún servicio de pedido — no es un dato de proceso operativo.
- [HECHO] Ningún worker/job de cocina. El único worker (`processDraftOrderTimeouts`, `src/index.ts`, tras `ENABLE_DRAFT_ORDER_WORKER`) gestiona vencimiento de carritos abandonados.
- [RECOMENDACIÓN] No hay nada parcial que extender para cocina — es terreno limpio, requiere modelos y endpoints completamente nuevos.

---

## 3. Arquitectura actual (tiempo real y comunicación)

- [HECHO] Mecanismo: Socket.IO real. Servidor `src/socket/adminSocket.ts` (`attachAdminSocket`), cliente `gesty-admin/contexts/admin-socket-context.tsx`. Un único namespace, path `/socket.io`.
- [HECHO] Autorización de conexión: middleware (`adminSocket.ts:103-131`) extrae JWT de `handshake.auth.token`/header/cookie, lo valida con `verifyAccessToken`, guarda `userId`/`businessId`/`role` en `socket.data`.
- [HECHO] Aislamiento multi-tenant correcto: el socket se une a la sala `admin:<businessId>` derivada **server-side** del JWT (función `adminRoom`, línea 31-33), no de un parámetro enviado por el cliente — no puede falsificarse.
- [HECHO — hallazgo clave] `ADMIN_NOTIFICATION_ROLES = Set(["OWNER","ADMIN"])` (línea 35); si el rol del socket no está en ese set, se desconecta inmediatamente (`adminSocket.ts:147-153`). Con los roles actuales (`OWNER, ADMIN, STAFF, DELIVERY, SUPER_ADMIN`), **`STAFF`/`DELIVERY` no pueden conectarse a este canal en absoluto**, ni hoy ni para un futuro de cocina sin modificar esta constante.
- [HECHO] Payloads reales (copiados literalmente): `admin:order` → `order.created {orderId, total, currency, at}`, `order.status_changed {orderId, status, message?, orderRef?, at}`, `order.payment_status_changed {orderId, payment_status, at}`, `order.payment_proof_received/checked {...}` (`adminSocket.ts:259-303`). `admin:reservation` (`:166-188`): payload igualmente mínimo. **Ninguno lleva líneas de producto.** No existe ningún `emitAdminTable*`/`emitAdminEnvironment*` (grep sin resultados).
- [HECHO] Reconexión: cliente configura `reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 8000` (`admin-socket-context.tsx:301-309`) — reconexión automática estándar, **sin ningún mecanismo de recuperación de eventos perdidos** durante la desconexión (sin buffer server-side, sin evento de resync al reconectar).
- [HECHO] El cliente desacopla consumo por tipo con type guards (`gesty-admin/lib/types/admin-realtime.ts`) y un patrón pub/sub interno reutilizable tal cual para un futuro canal de cocina.
- [DISEÑO] `admin:order` **no sirve tal cual** como canal de cocina: su payload no lleva productos, sus únicos destinatarios posibles son OWNER/ADMIN (bloqueado para el resto), y su sala es por negocio completo, no por estación.
- [DISEÑO] Propuesta mínima: `kitchen_ticket.created {ticketId, stationId, orderId, tableTabId?, at}` y `kitchen_ticket_item.status_changed {ticketItemId, status, at}` — mismo patrón "ID + fetch posterior" ya usado por `order.created`. Rooms nuevas: sala por estación/rol de cocina en paralelo a `admin:<businessId>`, con un set `KITCHEN_NOTIFICATION_ROLES` nuevo y paralelo a `ADMIN_NOTIFICATION_ROLES` (nunca reabriendo a `STAFF`/`DELIVERY` el acceso a *todo* lo que hoy reciben OWNER/ADMIN).
- [PENDIENTE] Qué recuperar al reconectar: dado que hoy no existe ningún resync, un futuro KDS (pantalla de larga duración, más propensa a desconexiones que el panel admin de escritorio) necesita, como mínimo, carga inicial vía REST de "tickets abiertos" al conectar/reconectar.

---

## 4. Brechas funcionales

| Brecha | Estado | Evidencia |
|---|---|---|
| Modelo de comandas (`kitchen_ticket`/`kitchen_ticket_item`) | [DISEÑO] inexistente | Confirmado por grep sin resultados en schema y código |
| Estaciones de preparación (`preparation_station`/`menu_item_station`) | [DISEÑO] inexistente | `category_tag` no sirve (es comercial); sin modelo de estación |
| Estado por producto dentro de un pedido | [DISEÑO] inexistente | `order_item` sin columna `status` |
| Ledger de anulaciones/ajustes (`order_item_adjustment`) | [DISEÑO] inexistente, sin precedente | Grep sin resultados; ya señalado también en el master spec |
| Canal de tiempo real cocina↔salón | [DISEÑO] inexistente | `admin:order` no transporta productos y excluye STAFF/DELIVERY por `ADMIN_NOTIFICATION_ROLES` |
| Roles MOZO/COCINA/CAJERO | [DISEÑO] inexistentes | `BUSINESS_USER_ROLES` = `SUPER_ADMIN, OWNER, ADMIN, STAFF, DELIVERY` |
| KDS (pantalla de cocina) | [DISEÑO] inexistente | Sin componentes en `gesty-admin` |
| Impresión térmica | [DISEÑO] inexistente | Sin dependencias ESC/POS en ningún `package.json` |
| Resync de estado al reconectar (cliente) | [DISEÑO] inexistente | `admin-socket-context.tsx` reconecta pero no resincroniza |
| Producto que requiere múltiples estaciones | [PENDIENTE] sin solución limpia | Ver §5 |

---

## 5. Análisis de estaciones

- [HECHO] `category_tag` (`STARTER/MAIN/SIDE/DRINK/DESSERT/OTHER`) confirmado, con grep propio, como clasificación puramente comercial (dos únicos consumidores: sugerencia de combo WhatsApp y filtro de catálogo admin). No es ni puede derivar en estación física.
- [PENDIENTE] **Producto que requiere varias estaciones** (ej. bife de chorizo con guarnición de puré → parrilla + cocina caliente): con `menu_item_station` N:N simple, un plato puede *asociarse* a 2 estaciones, pero eso generaría 2 `kitchen_ticket_item` idénticos diciendo "plato completo" en 2 tickets — ambiguo sobre qué estación prepara qué parte. Resolverlo correctamente requeriría una entidad de "componentes" (`menu_item_component{menu_item_id, station_id, label}`) que el diseño actual (master spec §3.2) no cubre. [RECOMENDACIÓN] Tratarlo como fuera de alcance de la Fase 3 inicial: cada `menu_item` se asigna a **una sola estación** en el primer lanzamiento; los platos multi-estación quedan como limitación conocida y documentada.
- [DISEÑO, hipotético] Modificadores futuros con precio propio (hoy inexistentes, solo `menu_item.variations` de nombre sin precio, 1/201 ítems de Sabrosón) podrían en teoría alterar la estación destino (ej. "agregar guarnición de papas fritas" → suma trabajo en Freidora) — mismo problema de "componentes" de arriba, no uno nuevo. [PENDIENTE], no resolver ahora.
- [DISEÑO] Productos sin necesidad de cocina (bebidas embotelladas): [RECOMENDACIÓN] no generan `kitchen_ticket_item` en absoluto (ausencia de fila en `menu_item_station` = sin ticket), en vez de inventar una estación ficticia de "despacho".
- [DISEÑO] Producto sin estación asignada (error de catálogo, no de diseño — ya se sabe por `SABROSON_POS_AUDIT.md` que el catálogo real tiene datos incompletos, ej. 25% de ítems sin precio): [RECOMENDACIÓN] fallback visible a una estación `default` ("sin estación asignada — revisar"), nunca bloqueo silencioso de la ronda completa.
- [DISEÑO] Preparación coordinada entre estaciones — tres alternativas evaluadas:
  1. **Sin coordinación automática** (manual, mirando el KDS): cero complejidad nueva, pero depende 100% de comunicación humana.
  2. **Agrupación visual por ronda en el KDS** (indicador de "esta ronda tiene pendientes en otras N estaciones", sin bloquear): complejidad baja-media (solo consulta agregada).
  3. **Bloqueo de "listo" hasta que toda la ronda esté lista en todas las estaciones**: garantiza simultaneidad real, pero **contradice el requisito explícito de entregas parciales** (una ensalada rápida quedaría retenida esperando un asado lento).
  - [RECOMENDACIÓN] Opción 2 para el primer lanzamiento; opción 3 descartada por incompatibilidad con entregas parciales salvo pedido explícito de negocio para platos puntuales.

---

## 6. Ciclo de vida de comandas y productos

### Estado de `kitchen_ticket` (comanda)
- [PENDIENTE/RECOMENDACIÓN] `pendiente_de_envío` y `enviada` son redundantes si la generación es atómica dentro de la transacción comercial (ver §10): el ticket nace ya emitido. Se recomienda colapsarlos en un único estado inicial `issued`.
- [PENDIENTE] `recibida_por_cocina` solo tiene valor si se quiere confirmar que el dispositivo de cocina mostró el ticket — más apropiado como evento de entrega de socket que como estado del ticket (decisión abierta).
- [DISEÑO] Estado final propuesto: `kitchen_ticket.status ∈ {issued, in_progress, partially_ready, ready, delivered, voided}`. `partially_ready` debe ser **derivado** (al menos un ítem listo/entregado y al menos otro no), nunca asignable manualmente. Se agrega `delivered` distinto de `ready` porque "listo en cocina" (actor: cocina) y "entregado en mesa" (actor: mozo) son eventos con actores distintos.

### Estado de `kitchen_ticket_item` (producto)
- [DISEÑO] `pendiente, en_preparación, listo, entregado, cancelado` se consideran necesarios y suficientes para el primer lanzamiento.
- [RECOMENDACIÓN] "Rechazado por falta de stock": no crear un estado nuevo — modelarlo como transición a `cancelado` con `cancel_reason` estructurado (`out_of_stock | customer_request | kitchen_error | ...`).
- [PENDIENTE] "En pausa": sin caso de negocio real identificado que lo justifique — se deja explícitamente sin resolver, no se inventa.

### Transiciones, actor y validez
- [HECHO] Roles reales existentes: `SUPER_ADMIN, OWNER, ADMIN, STAFF, DELIVERY`. **No existen** `MOZO`/`COCINA`/`CAJERO`. Cualquier mapeo de permisos de abajo es propuesta sobre roles que todavía no existen.
- [DISEÑO] `COCINA` (propuesto): solo el ciclo `pendiente→en_preparación→listo` (y `cancelado` con motivo); no marca `entregado` ni anula por motivo comercial. `MOZO` (propuesto): marca `entregado` sobre un ítem ya `listo`; solicita cancelaciones. `OWNER`/`ADMIN`: fuerzan cualquier transición manualmente, igual que hoy con `OrderStatus`.
- [DISEÑO] Registro de actor+timestamp: tabla de eventos nueva `kitchen_ticket_item_event{kitchen_ticket_item_id, from_status, to_status, actor_user_id, occurred_at}` — nunca solo sobrescribir `status`+`updated_at` en la fila principal.
- [DISEÑO] Transiciones inválidas deben rechazarse **a nivel de servicio** con una máquina de estados explícita y testeada — señalando expresamente no repetir el error ya detectado en `OrderStatus` (`getNextOrderStatus` definido pero nunca invocado en el PATCH admin).
- [DISEÑO] Cancelación post-inicio de preparación: genera `order_item_adjustment` con motivo y metadata de desperdicio; [PENDIENTE] quién autoriza (decisión de negocio, ver §11).
- [DISEÑO] Entrega parcial: `kitchen_ticket.status = partially_ready` derivado del conjunto de `kitchen_ticket_item.status`. Aviso al mozo: depende del canal de tiempo real (§3) — no se desarrolla el transporte aquí.
- [HECHO] Confirmado una vez más: `OrderStatus.ready_for_pickup` es estado de pedido completo del flujo take-away; ninguna transición de `kitchen_ticket`/`kitchen_ticket_item` debe inferirse de `OrderStatus` — son máquinas de estado independientes en capas distintas.

---

## 7. Rondas y modificaciones

Principio general: **no hay un único mecanismo para todo**. Se proponen tres, cada uno justificado por tipo de cambio — nunca UPDATE in place de una fila de negocio ya persistida, consistente con la inmutabilidad que ya rige `order_item`/`fiscal_invoice`:

- **(a) Evento de transición de estado** (`kitchen_ticket_item_event`, INSERT-only): para el flujo normal de estados (pending→in_progress→ready→delivered).
- **(b) Anulación compensatoria** (`order_item_adjustment`, ya propuesto en el master spec, reutilizado para cocina): para cualquier caso donde el producto a preparar/cobrar cambia (cancelación, cambio de cantidad, corrección de estación).
- **(c) Ticket complementario** (`kitchen_ticket` nuevo con `supersedes_ticket_id`/`origin: correction`): cuando cambia la estación destino o se agrega contenido nuevo a una ronda ya enviada — nunca se reescribe el ticket original porque cocina pudo haber empezado a trabajarlo.

| Escenario | Mecanismo | Nota |
|---|---|---|
| 1. Primera ronda, varias estaciones | Creación — N `kitchen_ticket` nuevos | No es modificación |
| 2. Segunda ronda | `orders` nueva con mismo `table_tab_id`; tickets propios, nunca reabre los anteriores | Aislamiento por diseño, no mitigación |
| 3. Estación incorrecta | (c) anula ítem en estación equivocada + crea en la correcta; si ya empezó, `voided_after_start: true` | Alimenta reporte de desperdicio |
| 4. Cancelado antes de `in_progress` | (b) simple, sin autorización especial | Síncrono y bloqueante; si cocina ya avanzó entre el pedido y el procesamiento, redirige al caso 5 |
| 5. Cancelado después de `in_progress` | (b) con `reason`, `authorized_by`, `wasted: true` | [PENDIENTE] quién autoriza — ver §11 |
| 6. Modificación tardía ("sin cebolla") | (b) `type: modification`, nota nueva, ticket original no se reescribe | Trazable si la nota llegó antes/después de empezar a cocinar |
| 7. Agregado de adicionales | (b) `type: addition` | Depende de que exista sistema de modificadores con precio (hoy inexistente) |
| 8. Preparación parcial (3 de 5) | `kitchen_ticket_item_event{ready_quantity_delta}`; estado derivado por agregación, nunca campo cacheado | Mismo principio que el saldo de cuenta del master spec |
| 9. Reenvío por error | Prevención por idempotencia (§8), no "historial de modificación" | Claim `(order_id, station_id)` devuelve el existente |
| 10. Caída de conexión durante envío | Cliente nunca asume éxito sin confirmación explícita; al reconectar pide estado real, no reintenta a ciegas | Ver §8 |

[RECOMENDACIÓN] Los tres mecanismos coexisten a propósito; ninguno es UPDATE in place. [PENDIENTE] Quién autoriza la cancelación post-inicio de preparación (escenario 5) — decisión de rol, ver §11.

---

## 8. Tiempo real

(Detalle completo en §3 — aquí la síntesis operativa.)

- [HECHO] `admin:order`/`admin:reservation` son insuficientes tal cual: payload sin productos, destinatarios limitados a OWNER/ADMIN (`ADMIN_NOTIFICATION_ROLES`), sala por negocio completo sin granularidad de estación.
- [DISEÑO] Eventos nuevos propuestos: `kitchen_ticket.created`, `kitchen_ticket_item.status_changed` — payload mínimo (IDs), patrón "ID + fetch posterior" ya validado en el repo.
- [DISEÑO] Necesario: un `KITCHEN_NOTIFICATION_ROLES` nuevo y paralelo a `ADMIN_NOTIFICATION_ROLES`, y al menos una sala nueva (por estación o por rol de cocina).
- [PENDIENTE] Mecanismo de resync al reconectar: hoy no existe ninguno; un KDS lo necesita como requisito, no como mejora futura.

---

## 9. KDS e impresión

### KDS [DISEÑO]
- Pantalla web, reutilizando Next.js + patrón de `gesty-admin` (no app nativa — sin evidencia de necesitarla).
- Alimentación: snapshot inicial vía REST (`GET /api/admin/kitchen/tickets?station=...&status=open`) + updates incrementales vía socket. **Nunca solo-socket** — la reconexión sin resync (confirmado en §3/§8) exige refetch REST completo al reconectar.
- Payload mínimo por tarjeta: `kitchen_ticket.id`, `order_id`, `station_id`, `status`, `created_at` (antigüedad calculada en cliente), lista de `kitchen_ticket_item` con nombre/cantidad/variación/notas y estado individual. **No necesita precio ni monto** (ver §11).
- [PENDIENTE] Resolución de "mesa y número de ronda": requiere recorrer `order.table_tab_id → table_tab_table → table.name`; el número de ronda (ordinal dentro del `table_tab`) — ¿se calcula en consulta o se cachea al crear la ronda? Decisión abierta.

### Impresión [DISEÑO]
- Impresoras térmicas por estación: vía red local (ESC/POS sobre TCP/IP, librerías tipo `node-thermal-printer`/`escpos`, **ninguna instalada hoy**) o un print-agent local, sin exponer la impresora a internet.
- Reimpresión: operación de **lectura** sobre el ticket ya emitido — nunca regeneración, consistente con el patrón de `invoice.service.ts`.
- [DISEÑO] Tabla nueva `print_job{id, kitchen_ticket_id, requested_by, status: queued|sent|failed|acknowledged, attempt_count, created_at}` para distinguir primera impresión de reimpresión y registrar fallas sin reintento automático indefinido.

### Recomendación
- [RECOMENDACIÓN] **Priorizar KDS web, dejar impresión para una etapa posterior.** KDS reutiliza el 100% de los patrones ya existentes (socket.io-client, JWT, REST); impresión térmica es la pieza de mayor incertidumbre técnica de toda la auditoría, sin ningún precedente en el código, y no es bloqueante para una demo mínima (el valor demostrable —cocina ve y actualiza en tiempo real— no depende de papel). El propio `kitchen_ticket.status` del master spec ya admite `printed` como opcional, no obligatorio.

---

## 10. Concurrencia e idempotencia

- [HECHO] Patrones existentes reutilizables: `pg_advisory_xact_lock` keyed por negocio (`acquireOrderCreateLock`, `checkout.service.ts:85-100`); claim transaccional con estados y staleness (`claimInvoiceRow`/`decideFromExisting`, `invoice.service.ts:112-215`). Antipatrón conocido a evitar: `handleDraftOrder` (`order.service.ts:399-426`, sin lock, condición de carrera real ya documentada).

| Escenario | Mecanismo recomendado |
|---|---|
| Doble confirmación / reintento / reenvío por error | `@@unique([order_id, station_id])` en `kitchen_ticket`; `create` con manejo de conflicto de unicidad devuelve el existente |
| Reconexión de Socket.IO (datos) | Snapshot fresco por cuenta/estación al reconectar, nunca replay de eventos |
| Eventos duplicados | Idempotency key por evento (`business_id:order_id:station_id:event_type`), análoga a la de facturación |
| Dos cocineros tocan el mismo ítem | Compare-and-swap SQL (`UPDATE ... WHERE status = 'pending' RETURNING *`), no `findUnique`+`update` separados |
| Cancelación simultánea con "listo" | Misma técnica compare-and-swap; si ya está `ready`/`delivered`, rechaza cancelación simple y exige flujo de cancelación post-inicio |
| Caída a mitad de generar N tickets de una ronda | Una única transacción (todo o nada) para los N `kitchen_ticket`+`kitchen_ticket_item` de la ronda |

- [RECOMENDACIÓN — decisión central] La **creación** de `kitchen_ticket`/`kitchen_ticket_item` debe ser **síncrona**, en la misma transacción comercial que confirma la orden — no fire-and-forget como la facturación. Razón: una orden de salón sin comanda generada es un estado operativo grave; una factura demorada no bloquea el salón. Lo que sí debe ser asíncrono post-commit: notificación de socket, impresión física, métricas/reportes derivados.
- [PENDIENTE] Si el volumen de estaciones por ronda crece mucho (8+), evaluar outbox pattern. Hoy (2-4 estaciones típicas) es sobre-ingeniería — la transacción síncrona directa evita la ventana de inconsistencia entre "orden confirmada" y "comanda generada", que es justamente lo que se quiere evitar en salón.

---

## 11. Seguridad y roles

- [HECHO] `BUSINESS_USER_ROLES` = `SUPER_ADMIN, OWNER, ADMIN, STAFF, DELIVERY` (`src/types/auth.ts:2-8`). `requireRoles(...)` (`auth.middleware.ts:55-67`) es un chequeo simple sobre el rol del JWT — un rol por usuario autenticado, no por dispositivo/estación. Confirmado con grep propio: **cero** usos de `requireRoles("STAFF", ...)` o con `"DELIVERY"` en todo `src/routes/` — acceden hoy por exclusión.
- [HECHO] Aislamiento multi-tenant: `tenantBusinessId(req)` (`auth.middleware.ts:47-53`), manual por query, sin Row-Level-Security de respaldo (riesgo estructural preexistente).

### Roles propuestos [DISEÑO] — ninguno existe hoy

| Rol | Alcance propuesto |
|---|---|
| OWNER/ADMIN (existentes) | Acceso total — sin cambios |
| MOZO (nuevo) | Abre/cierra cuentas, crea rondas, ve comandas de sus mesas, marca `entregado`. No cambia estado de preparación ni reimprime desde cero una decisión comercial |
| COCINA (nuevo) | Ciclo `pendiente→en_preparación→listo` de sus tickets. No ve montos ni medios de pago |
| CAJERO (nuevo) | Ve saldo/consumo, aplica pagos, cierra cuenta. Ve montos que COCINA no debe ver |

- [RECOMENDACIÓN] Multi-tenant de comandas: mismo patrón ya usado (`tenantBusinessId`), sin mecanismo nuevo, solo disciplina.
- [RECOMENDACIÓN] Estaciones no autorizadas: para el MVP, rol `COCINA` genérico alcanza (ve todas las estaciones); diferir el vínculo usuario↔estación a una fase posterior.
- [PENDIENTE] Modificación de productos ya en comanda: propuesto que solo MOZO/OWNER/ADMIN la soliciten (nunca COCINA directamente), siempre vía `order_item_adjustment`.
- [PENDIENTE] Cancelación antes de `in_progress`: cualquier MOZO/OWNER/ADMIN sin fricción. Después de `in_progress`: confirmación explícita de doble paso, registro de quién canceló; COCINA no debería poder cancelar por cuenta propia.
- [DISEÑO] Reimpresiones: MOZO y COCINA pueden reimprimir su propia estación/mesa (operación de lectura, bajo riesgo), siempre registrado en `print_job.requested_by`.
- [RECOMENDACIÓN] El payload que llega a cocina **no debe incluir precios ni montos** — DTO específico (`KitchenTicketView`) separado del DTO completo de `orders`/`order_item` que usa el panel admin.

No se inventan permisos que el sistema no tenga: todo lo anterior es [DISEÑO]/[PENDIENTE] explícito.

---

## 12. Escenarios de validación para Sabrosón

> Evaluación de papel, estado HOY (sin el diseño futuro implementado), sin ejecutar ninguna operación real.

| Escenario | Estado HOY | Evidencia | Brecha | Dependencia | Riesgo | Recomendación |
|---|---|---|---|---|---|---|
| Primera ronda → comanda una sola vez | Inexistente | Sin `kitchen_ticket`; `orders` sin `table_tab_id` | `table_tab` + módulo de comandas completo | Fases 0-1 del master spec | Bajo hoy (nada que ejecutar); real al implementar sin claim | Implementar claim idempotente `(order_id, station)` desde el primer commit |
| Segunda ronda → solo productos nuevos | Inexistente | Sin agrupador de rondas | `table_tab`, generación por ronda | `table_tab` | Bajo si se respeta "nunca reprocesar rondas viejas" | Generar comandas solo desde los `order_item` de la ronda nueva |
| Varias estaciones → cada una recibe lo suyo | Inexistente | Sin `preparation_station`/`menu_item_station`; `category_tag` no sirve | Modelar + asignar estación a los ~201 `menu_item` (hoy ninguno tiene) | Fase 3 | Medio — faltaría asignación el día de la demo | Cargar asignación solo para el subconjunto de ítems deduplicados a usar en la demo |
| Producto listo → estado individual | Inexistente | `order_item` sin columna de estado | `kitchen_ticket_item.status` completo | Fase 3 | Bajo conceptual, alto esfuerzo (primera vez con estado por producto) | Lanzar con 2-3 estados, no los 5 completos |
| Entrega parcial | Inexistente | Mismo motivo que el anterior | Depende de "producto listo" | — | Medio — fácil confundir `ready` con `delivered` | Modelar `ready`/`delivered` como transiciones distintas desde el inicio |
| Cancelación con historial | Inexistente como comanda | Sin `order_item_adjustment` en ningún lado del código | Ledger de ajustes nuevo, sin precedente | Diseño completo nuevo | Alto si se implementa como UPDATE; bajo si se respeta "fila nueva" desde el diseño | No implementar cancelación de comanda sin `order_item_adjustment`, aunque sea mínimo |
| Reconexión de cocina → recupera estado real | Inexistente (ni pantalla ni mecanismo) | Socket reconecta pero no resincroniza | Endpoint REST de snapshot + KDS | Fase 3 + §9 | Alto si se construye solo-socket | Refetch-on-reconnect como requisito desde el primer commit del KDS |
| Doble envío → no duplica | Inexistente (nada que duplicar aún) | Patrón de prevención ya existe para casos análogos (`checkout.service.ts`, `invoice.service.ts`) | Aplicar `@@unique(order_id, station)` | — | Medio — riesgo real en cualquier sistema con reintentos | Reusar textualmente el patrón ya validado, no reinventar |
| Varias mesas simultáneas → sin mezcla | Parcial (aislamiento general sí, mesas/cuentas no) | `tenantBusinessId` ya implementado en todo el repo | Extender a `table_tab`/`kitchen_ticket` | Disciplina de `business_id` en cada query nueva | Medio-estructural, preexistente | Test de aislamiento multi-tenant específico desde la primera implementación |
| Pedido delivery → conserva flujo | Disponible, si se respeta el diseño | `table_tab_id` propuesto nullable; órdenes externas no obligadas a tener cuenta | — | Auditar ~6+ archivos con default binario de `FulfillmentType` antes de agregar `DINE_IN` | Bajo si se audita antes; alto si no | Tratar esa auditoría como obligatoria previa, no opcional |
| Pedido take-away → conserva flujo | Disponible, mismo razonamiento | Idéntico al anterior | Misma | Misma | Mismo | Tratar delivery y take-away como un solo punto de regresión conjunta |

---

## 13. Propuesta conceptual (síntesis)

> Esta sección sintetiza, sin aprobar como implementación, el diseño que surge de §5-§11, extendiendo (no sustituyendo) el boceto ya existente en `POS_MASTER_SPEC.md §3.2`.

```
// ILUSTRATIVO — conceptual, no existe en el repo, no se aplica
model preparation_station {
  id          String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  business_id String @db.Uuid
  name        String
}

model menu_item_station {          // N:N, deliberadamente separado de category_tag
  menu_item_id String @db.Uuid
  station_id   String @db.Uuid
  // [RECOMENDACIÓN] primer lanzamiento: 1 estación por menu_item (ver §5, caso multi-estación sin resolver)
}

model kitchen_ticket {
  id          String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  order_id    String @db.Uuid      // 1 ronda, nunca agrupa varias (ver §7)
  station_id  String @db.Uuid
  status      String              // issued | in_progress | partially_ready | ready | delivered | voided
  table_tab_id_snapshot String?    // denormalizado de solo lectura, ver nota de snapshot abajo
  table_label_snapshot  String?    // idem — nunca se reescribe si luego se transfiere/fusiona la mesa/cuenta
  @@unique([order_id, station_id]) // idempotencia — ver §10
}

model kitchen_ticket_item {
  id                String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  kitchen_ticket_id String @db.Uuid
  order_item_id     String @db.Uuid
  status            String   // pending | in_progress | ready | delivered | cancelled
  quantity_ready    Int?     // o derivado de eventos, ver escenario de preparación parcial (§7)
}

model kitchen_ticket_item_event {   // INSERT-only, actor+timestamp, nunca se edita una fila pasada
  id                     String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  kitchen_ticket_item_id String @db.Uuid
  from_status            String?
  to_status              String
  actor_user_id          String? @db.Uuid
  occurred_at            DateTime @default(now())
  ready_quantity_delta   Int?
}

model print_job {                  // ver §9
  id                String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  kitchen_ticket_id String @db.Uuid
  requested_by      String @db.Uuid
  status            String  // queued | sent | failed | acknowledged
  attempt_count     Int @default(0)
  created_at        DateTime @default(now())
}
```

- **Cardinalidades**: `table_tab(1)─<orders(N rondas)─<kitchen_ticket(0..k, k=estaciones con producto en esa ronda)─<kitchen_ticket_item(1 por order_item incluido)`.
- **Trazabilidad**: `kitchen_ticket.order_id` → ronda → (vía `orders.table_tab_id`) cuenta → mesa; `kitchen_ticket_item.order_item_id` → snapshot inmutable del producto. Denormalización de solo lectura de mesa/cuenta en `kitchen_ticket` para que un ticket ya mostrado en cocina no cambie retroactivamente de leyenda si luego se transfiere la mesa o se fusiona la cuenta (`table_tab_merge`) — consistente con la disciplina de snapshots que ya usa el resto del sistema.
- **Modificaciones**: nunca UPDATE in place — tres mecanismos (evento de transición, `order_item_adjustment`, ticket complementario), elegidos según el tipo de cambio (§7).
- **Idempotencia**: `@@unique([order_id, station_id])` + generación síncrona dentro de la transacción comercial (§10).
- **Tiempo real**: eventos nuevos ligeros (`kitchen_ticket.created`, `kitchen_ticket_item.status_changed`), sala nueva por estación/rol, `KITCHEN_NOTIFICATION_ROLES` paralelo a `ADMIN_NOTIFICATION_ROLES` (§3/§8).
- **KDS**: snapshot REST + updates incrementales por socket, nunca solo-socket (§9).
- **Extensibilidad de impresión**: `print_job` como tabla de intención/registro, desacoplada del modelo de ticket — permite agregar impresión después sin tocar `kitchen_ticket` (§9).

[PENDIENTE] Si estos conceptos son suficientes o faltan otros: queda abierto el caso de productos multi-estación (§5) como la brecha de modelo más significativa no resuelta por esta propuesta.

---

## 14. Integración con las auditorías A y B previas

- **`table_tab`/`table_tab_table`**: la generación de comandas depende por completo de que exista primero `orders.table_tab_id` (Fase 1 del master spec) — sin ronda agrupada, no hay "comanda de una cuenta" con sentido, solo un pedido aislado indistinguible de uno de WhatsApp. Esta auditoría no reabre esa dependencia, la reconfirma con el detalle nuevo de idempotencia y concurrencia (§10).
- **`orders`/`order_item`**: la inmutabilidad ya vigente en `order_item` (confirmada de nuevo, §2) es la base sobre la que se apoyan los tres mecanismos de modificación de comandas (§7) — ninguno de los tres rompe esa disciplina, todos la extienden.
- **Pagos y cierre de cuenta**: fuera de alcance de esta auditoría (Auditoría D del master spec, caja), pero se señala una dependencia nueva no trivial: si cancelar un producto ya en preparación debe reflejarse automáticamente en el saldo de la cuenta (`tab_payment`), el `order_item_adjustment` de cocina y el de pagos deben ser la misma entidad o reconciliarse explícitamente — **no resuelto aquí**, cruza directamente con la Fase 2 del master spec.
- **Facturación**: sin impacto directo de cocina sobre `billable_charge`/`fiscal_invoice` más allá de que un producto cancelado post-facturación parcial requeriría el mismo mecanismo de nota de crédito que el master spec ya señaló como bloqueante (`credit_note` sin servicio emisor, `POS_MASTER_SPEC.md §5.1`) — no se repite aquí el análisis, se hereda el bloqueo.
- **Reservas**: sin relación directa — las reservas gestionan expectativa futura de visita, nunca ocupación operativa ni comandas (confirmado también en `SABROSON_POS_AUDIT.md`).
- **Delivery y take-away**: confirmado explícitamente (§12) que el diseño no los toca siempre que se respete `table_tab_id` nullable y se audite antes el uso de `FulfillmentType` en los ~6+ archivos con defaults binarios ya señalados por el master spec.
- **Seguridad/roles**: la Auditoría E del master spec (pendiente, fuera de alcance de A/B/C) es donde deben aprobarse formalmente los roles MOZO/COCINA/CAJERO propuestos aquí (§11) — esta auditoría los propone pero no los da por aprobados.

---

## 15. Decisiones pendientes

1. **[PENDIENTE]** Quién autoriza la cancelación de un producto después de iniciada su preparación (§6, §7, §11) — rol/flujo de aprobación no resuelto.
2. **[PENDIENTE]** Cómo resolver productos que requieren más de una estación física — sin solución limpia con el modelo N:N simple (§5, §13).
3. **[PENDIENTE]** Si `recibida_por_cocina` debe ser un estado del ticket o un evento de entrega de socket (§6).
4. **[PENDIENTE]** Cómo se calcula/cachea el "número de ronda" dentro de una cuenta para mostrarlo en el KDS (§9).
5. **[PENDIENTE]** Si un ajuste de cocina (producto cancelado) debe generar automáticamente un ajuste comercial de cobro, o son dos registros reconciliados manualmente — cruza con Fase 2 del master spec (§14).
6. **[PENDIENTE]** Si `MOZO` reemplaza a `STAFF` para ese perfil operativo o convive como rol nuevo adicional (§11).
7. **[PENDIENTE]** Umbral de volumen de estaciones a partir del cual la generación síncrona de tickets deja de ser adecuada y se justifica un outbox pattern (§10).

---

## 16. Recomendación de implementación por etapas

Se adopta y detalla la Fase 3 ya prevista en `POS_MASTER_SPEC.md §7` ("Comandas y estaciones"), con el detalle adicional producido por esta auditoría:

1. **Extender `ADMIN_NOTIFICATION_ROLES`/crear `KITCHEN_NOTIFICATION_ROLES`** antes de escribir cualquier otra pieza — de otro modo cualquier rol de cocina quedará desconectado del tiempo real por un detalle ya identificado (§3), no por diseño.
2. **Modelo mínimo**: `preparation_station`, `menu_item_station` (1 estación por `menu_item`, sin resolver multi-estación), `kitchen_ticket`/`kitchen_ticket_item` con `@@unique([order_id, station_id])`, generación **síncrona** dentro de la transacción de confirmación de la ronda (§10).
3. **Ciclo de vida mínimo**: 2-3 estados por producto (`pending/in_progress/ready`) antes de los 5 completos; `kitchen_ticket_item_event` desde el primer commit (no como mejora posterior) para no repetir el error de `getNextOrderStatus` sin enforcement.
4. **Canal de tiempo real**: eventos `kitchen_ticket.created`/`kitchen_ticket_item.status_changed`, payload mínimo, sala nueva por estación.
5. **KDS web mínimo**: snapshot REST + socket, con refetch-on-reconnect como requisito desde el primer commit (§9, §12).
6. **Impresión**: explícitamente diferida a una etapa posterior — no bloqueante para demostrar el flujo (§9).
7. **Antes de la demo en Sabrosón**: cargar asignación estación↔producto solo para el subconjunto de ítems deduplicados que se usarán en el escenario (no los ~201 reales, muchos duplicados — ver `SABROSON_POS_AUDIT.md`), y auditar los ~6+ archivos con default binario de `FulfillmentType` antes de agregar `DINE_IN` si ese paso aún no se hizo.

No se convierte esta secuencia en backlog de tareas de código — cada paso requiere diseño técnico detallado propio antes de implementarse, y los puntos de la §15 deben resolverse explícitamente antes de iniciar el paso correspondiente.

---

## Partes no verificables en esta auditoría

- No se auditó el detalle completo de `gesty-admin/lib/types/admin-realtime.ts` línea por línea (se usó como referencia de type guards, no se citó su contenido exacto).
- No se revisaron otros repos hermanos no relacionados a Gesty.
- El impacto de un sistema de modificadores con precio propio sobre la asignación de estación es evaluado solo como hipotético — no existe ese sistema hoy, por lo que no hay evidencia real que verificar.
- No se ejecutó ninguna operación real para "demostrar" ningún escenario de la §12, conforme a la restricción de la tarea.
