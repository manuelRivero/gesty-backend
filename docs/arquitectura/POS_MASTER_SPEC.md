# POS_MASTER_SPEC — Especificación de referencia para el futuro POS de Gesty

> Documento de síntesis. Consolida las Auditorías A (núcleo comercial), B (salón/mesas/reservas) y C (cocina/comandas), todas de solo lectura, realizadas sobre `gesty-backend` en la rama `intent_lifecicle_poc`. No modifica código, schema ni configuración — es exclusivamente análisis y documentación.
>
> Convención de evidencia usada en todo el documento:
> - **[HECHO]** — comprobado en el código actual, con cita `archivo:línea`.
> - **[DISEÑO]** — propuesta conceptual para el futuro POS. No existe en el repo. Nunca se aplicó ni se migró.
> - **[PENDIENTE]** — decisión funcional/de negocio no resuelta por las auditorías; requiere aprobación explícita.

---

## 1. Resumen ejecutivo

Gesty es hoy un agente conversacional de WhatsApp (LangGraph/LangChain + Express + Prisma) con panel admin (`gesty-admin`, Next.js) y storefront web, que cubre **pedidos externos**: delivery y take-away, reservas de mesa por WhatsApp, catálogo/promociones, carrito/checkout, pagos (efectivo/transferencia/Mercado Pago) y facturación electrónica en desarrollo (Sistemas 360).

El núcleo comercial (`orders`/`order_item`, checkout, promociones) está **bien construido para ese propósito** y es reutilizable como base de ronda de pedido. Pero **no tiene ningún punto de apoyo para salón presencial**: no existe relación mesa↔pedido, no hay cuenta abierta/consumo acumulado, los pedidos confirmados son inmutables (sin agregar/cancelar ítems después), los pagos son binarios (sin parciales ni divididos), y no existe ninguna infraestructura de cocina/comandas (ni backend ni frontend).

La dirección arquitectónica para resolver esto ya fue decidida y cerrada en una PoC de tres pasadas: introducir **`table_tab`** (cuenta) como agrupador independiente de `orders` (rondas), con un ledger de pagos propio (`tab_payment`/`tab_payment_application`), una entidad de facturación intermedia (`billable_charge`), relación N:N mesa↔cuenta (`table_tab_table`), unificación de cuentas por relación sin reasignar historial (`table_tab_merge`), y un ledger de anulaciones (`order_item_adjustment`). Esta decisión **no se vuelve a discutir** en este documento ni en las auditorías siguientes salvo evidencia nueva que la invalide.

La Auditoría B confirmó además que **no existe ningún estado de ocupación física de mesa**, ni walk-in, ni asignación/transferencia manual de mesas por mozo — todo lo que existe hoy en `table`/`reservation*` es para el flujo de reserva por WhatsApp, no para operación de salón en vivo.

La Auditoría C confirmó que **no existe ninguna capa de cocina**: `OrderStatus.preparing`/`ready_for_pickup` son estados logísticos de la orden completa (delivery/take-away), nunca por producto. No hay estaciones, no hay tickets, no hay impresión, no hay KDS — ni en el backend ni en `gesty-admin`.

**Fortalezas a conservar:** el patrón de idempotencia con `pg_advisory_xact_lock` + relectura bajo lock (`checkout.service.ts`), la separación de estado logístico/pago/fiscal, el motor de promociones con snapshot congelado, el aislamiento multi-tenant consistente por `business_id`, y el patrón de efectos secundarios desacoplados (fire-and-forget post-commit).

**Riesgos activos ya identificados, independientes del POS:** `handleDraftOrder` sin lock (condición de carrera real), `getNextOrderStatus` nunca invocado para validar transiciones de estado admin, y (ya corregido durante estas auditorías) falta de `requireRoles` en `GET /reservations`.

---

## 2. Estado actual comprobado de Gesty

### 2.1 Mapa de capacidades — qué es cada cosa realmente

| Concepto | Qué es HOY [HECHO] | Para qué fue diseñado | Confusión a evitar |
|---|---|---|---|
| `orders`/`order_item` | Pedido confirmado, inmutable desde `placed`. Cero `order_item.update/delete/upsert` fuera de la creación en `src/services/checkout.service.ts:265-297` (también documentado como `:286-347` en la Auditoría C, mismo bloque). | Unidad de venta por pedido (WhatsApp/storefront), delivery/take-away. | **No es una comanda.** No tiene estado por producto. No es una "cuenta" — es una ronda aislada. |
| `payment_intent` | Intento de pago online (Mercado Pago), ligado a `draft_order_id` **o** `order_id` (XOR), `status` como `String` libre (`pending/approved/rejected/cancelled`), `prisma/schema.prisma:871-897`. | Pago único por pedido vía pasarela online. | No admite pagos parciales ni múltiples medios combinados. No debe reutilizarse tal cual para el ledger de salón. |
| `payment_proof` | Comprobante de transferencia subido por WhatsApp, 1:1 con una orden, valida monto exacto contra `total_amount` completo (`src/services/payment/paymentProofChecks.ts:44-51,119`). | Validación manual de transferencia bancaria. | No sirve para "cobré parte de la cuenta" — exige coincidencia total. |
| `table`/`environment` | Recurso físico con layout (`x,y,shape,width,height,rotation`, `capacity`) y agrupación por ambiente (`prisma/schema.prisma:592-605,660-682`). **Sin campo de estado de ocupación.** | Plano de salón para el motor de reservas por WhatsApp. | Existe el dato de plano, pero **no hay noción de mesa libre/ocupada en tiempo real**, ni relación con `orders`. |
| `reservation`/`reservation_table`/`reservation_block` | Expectativa futura de visita: quién, cuándo, cuántos, qué mesa(s) prometidas. `reservation_table` ya es N:N reserva↔mesa (`@@unique([reservation_id, table_id])`, `prisma/schema.prisma:629`). | Reserva de mesa gestionada por el bot de WhatsApp. | No equivale a "mesa ocupada ahora". Check-in (`checkin.service.ts`) solo cierra el registro de reserva, no libera nada físico porque la mesa no tiene estado que liberar. |
| `FulfillmentType` | Enum con solo `DELIVERY`/`TAKE_AWAY` (`prisma/schema.prisma ~1024-1027`). | Modalidad de entrega del pedido. | No tiene valor para "consumo en el local". Al menos 6 archivos tienen defaults binarios no exhaustivos sobre este enum (Auditoría B, sección 6) que requerirían auditoría manual antes de agregar `DINE_IN`. |
| `OrderStatus`/`OrderPaymentStatus` | `OrderStatus` lineal orientado a delivery/take-away (`draft→placed→preparing→{shipped\|ready_for_pickup}→delivered`, con `cancelled` terminal fuera del pipeline). `OrderPaymentStatus` binario `unpaid\|paid` (`prisma/schema.prisma ~1011-1035`). | Logística de entrega y estado de cobro por pedido. | `preparing`/`ready_for_pickup` **no son estados de cocina** — son logísticos de la orden completa. `getNextOrderStatus` (`src/constants/orderWorkflow.ts:58-74`) existe pero no se invoca en ningún PATCH admin — no hay enforcement real de la máquina de estados. |
| `fiscal_invoice` | Comprobante fiscal (Sistemas 360/AFIP), `@@unique([business_id, order_id, kind])` (`prisma/schema.prisma ~1161`), idempotencia vía `idempotencyKey = businessId:orderId:kind` (`src/services/invoicing/invoice.service.ts:52-54`). `credit_note` existe en el enum `FiscalInvoiceKind` pero **sin ningún servicio que lo emita** (confirmado por grep sin resultados). | Facturación 1:1 por pedido de e-commerce. | Asume 1 comprobante = 1 orden. No soporta hoy facturación parcial ni consolidada de varias órdenes sin rediseño. |
| Socket.io / `admin:order` | Servidor real (`socket.io`, `src/socket/adminSocket.ts`), salas por negocio. Eventos `order.created`/`order.status_changed`/`order.payment_status_changed` con payload mínimo (sin líneas de producto). También hay canales de reservas (`emitAdminReservation*`). **No existe ningún `emitAdminTable*`/`emitAdminEnvironment*`.** | Notificaciones/toasts del panel admin (`gesty-admin`, vía `socket.io-client`, `contexts/admin-socket-context.tsx`). | No fue diseñado para cocina. Es el punto de extensión más natural si se quisiera un canal hacia un futuro KDS, pero hoy no transporta el detalle necesario. |
| `category_tag` (`menu_category`) | Enum `STARTER/MAIN/SIDE/DRINK/DESSERT/OTHER` — clasificación de menú/UX para agrupar el resumen de WhatsApp/storefront. | Presentación del catálogo al cliente. | **No es una estación de cocina.** Un DESSERT no implica una única estación física (puede salir de pastelería o de barra). No confundir clasificación comercial con flujo físico de preparación. |
| `menu_item.preparation` | Campo de texto libre (receta/instrucciones), usado en varios servicios de menú y enriquecimiento IA. | Información descriptiva del plato. | No es un estado operativo de preparación — es texto, no dato de proceso. |

### 2.2 Clasificación de capacidades (vista consolidada)

| Capacidad | Estado | Evidencia |
|---|---|---|
| Carrito, checkout, pricing, promociones | **Implementado y funcional** | `src/services/cart.service.ts`, `checkout.service.ts:85-377`, `pricing.service.ts:125-163`, `resolveCartPromotions.ts` |
| Idempotencia en creación de orden/pago online | **Implementado y funcional** | `pg_advisory_xact_lock` en `checkout.service.ts:85-100` (también citado como `85-96` en Auditoría A), reusado en `payment.service.ts:489-556` |
| Idempotencia en creación de carrito (`draft_order`) | **Implementado parcialmente** | `handleDraftOrder` (`src/services/order.service.ts:399-426`) sin lock ni `@@unique` de respaldo — condición de carrera real, documentada en A, B y C |
| Enforcement de máquina de estados de pedido | **Implementado parcialmente** | `getNextOrderStatus` (`orderWorkflow.ts:58-74`) definido pero nunca invocado en el PATCH admin |
| Facturación electrónica (Sistemas 360) | **Implementado parcialmente** | Motor de reclamo/reconciliación sólido (`claimInvoiceRow`/`decideFromExisting`, `invoice.service.ts:112-215`) pero 1:1 con orden, sin `credit_note` real, sin soporte de consolidación |
| Reservas por WhatsApp (disponibilidad, combinación de mesas) | **Existente, pero con una finalidad diferente a la que necesita el POS** | `findAvailableTable`/`selectTables` (`src/services/reservations/`) — solo para reserva futura, no operación de salón en vivo |
| Mesa como recurso físico (plano, capacidad) | **Existente, pero con una finalidad diferente** | Dato completo en `table` (`prisma/schema.prisma:660-682`), expuesto por API admin, pero sin consumidor de ocupación en tiempo real |
| Mesa↔pedido | **Inexistente** | `orders` no tiene `table_id`; `table` solo se relaciona con reservas |
| Cuenta abierta / consumo acumulado | **Inexistente** | Sin modelo ni lógica — `table_tab` es diseño futuro |
| Estado de ocupación física de mesa | **Inexistente** | Sin campo `status`/`is_occupied` en `table` |
| Walk-in / asignación manual de mesa | **Inexistente** | Cero funciones de asignación fuera del flujo de reserva |
| Modificación/cancelación parcial de pedido confirmado | **Inexistente** | `order_item` inmutable; cancelación es solo a nivel de orden completa |
| Pagos parciales / múltiples medios combinados | **Inexistente** | `payment_proof` exige monto exacto; `payment_intent` es 1:1 pedido-pasarela |
| Cocina / comandas / estaciones / KDS / impresión | **Inexistente** | Confirmado por búsqueda exhaustiva sin resultados, en backend y en `gesty-admin` |
| Autorización de `GET /reservations` por rol | **Corregido durante estas auditorías** | `src/routes/adminOrders.routes.ts:555-559` — se agregó `requireRoles("OWNER","ADMIN")`, ya aplicado y validado (typecheck + suite de tests sin regresiones nuevas) |
| Aislamiento multi-tenant | **Implementado y funcional (por muestreo)** | Filtrado explícito por `business_id` en cada consulta revisada; sin Row-Level-Security de respaldo (riesgo estructural preexistente, no nuevo) |
| Pruebas de integración reales (Postgres) para locks de concurrencia | **Pendiente de verificación** | El propio repo reconoce la limitación en comentario de test (`createOrderFromDraftIdempotency.test.ts`) |

---

## 3. Modelo operativo conceptual futuro [DISEÑO]

> Todo lo que sigue en esta sección es diseño conceptual ya aprobado en la PoC de tres pasadas. Ninguna de estas entidades existe en el repo. No se vuelve a comparar contra las opciones descartadas (ver §8 de la PoC: Opción 1 "`table_id`+rondas" y Opción 3 "orden mutable `open_tab`", ambas rechazadas a favor de esta).

### 3.1 Cuenta abierta (`table_tab`)

```prisma
// ILUSTRATIVO — conceptual, no existe en el repo, no se aplica
model table_tab {
  id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  business_id String   @db.Uuid
  status      TableTabStatus @default(open)  // open | closed | merged
  opened_at   DateTime @default(now()) @db.Timestamptz(6)
  closed_at   DateTime? @db.Timestamptz(6)
  orders           orders[]
  tables           table_tab_table[]
  tab_payment      tab_payment[]
  billable_charge  billable_charge[]
}

model table_tab_table {   // N:N cuenta↔mesa, nunca 1:1
  table_tab_id String @db.Uuid
  table_id     String @db.Uuid
  // índice único parcial real (ya probado en este repo, ver §4.3): a lo sumo
  // una cuenta `open` por mesa — requiere desnormalizar `status` aquí o
  // resolverlo con migración SQL manual (CREATE UNIQUE INDEX ... WHERE)
}

model table_tab_merge {  // unificación por relación, SIN reasignar historial
  primary_tab_id String @unique: false @db.Uuid  // puede absorber N cuentas
  merged_tab_id  String @unique       @db.Uuid  // se fusiona una sola vez
  merged_at      DateTime @default(now())
}
```

Responsabilidades que debe cubrir (ya evaluadas en la PoC, ver detalle de escenarios en §3.1.1):
- Apertura de cuenta (con o sin mesa asignada todavía).
- Asignación de una o varias mesas (N:N, cubre mesas unidas físicamente).
- Consumo acumulado: suma derivada de `orders.total_amount` de todas las rondas de la cuenta — **nunca** un campo cacheado mutado.
- Incorporación de nuevas rondas: cada ronda nueva es una `orders` nueva con `table_tab_id` seteado; la ronda anterior permanece intacta.
- Cambio de mesa: no se edita la fila de `table_tab_table` (pierde trazabilidad) — se cierra la asignación vieja y se abre una nueva.
- Unión de cuentas: `table_tab_merge`, nunca reasignando `orders.table_tab_id` ni pagos históricos.
- Separación de cuentas (split): modelado como vista de cobro (`table_tab_split`, opcional) que asigna ítems/montos a comensales — **no particiona `order_item`**.
- Cierre de cuenta: verificación de saldo = 0 (ver §3.3) antes de pasar a `closed`.
- Historial de movimientos: dado por la unión de `orders` + `tab_payment`/`tab_payment_application` de la cuenta (y de las cuentas fusionadas, resuelto por consulta, no por campo cacheado).

**[PENDIENTE]**: si se requiere historial completo de qué mesa ocupó la cuenta en qué rango horario, o alcanza con "mesa actual" sin versión histórica.

### 3.1.1 Ejemplo numérico de merge sin reasignar historial

- Cuenta A: 2 órdenes ($8000 total) + 1 pago confirmado de $3000.
- Cuenta B: 1 orden ($4000 total), sin pagos.
- Merge: `table_tab_merge{primary_tab_id: A, merged_tab_id: B}`.
- Saldo consolidado = consumo (8000+4000=**12000**) − pagado (3000+0=**3000**) = **9000**.
- Ninguna fila de `orders`/`tab_payment` se reescribe; la resolución camina `table_tab_merge` desde la cuenta primaria. El historial de B queda legible para siempre exactamente como ocurrió.

### 3.2 Cocina y comandas

Tres capas de estado explícitamente distintas (no colapsar nunca en una sola):

1. **Estado comercial de la orden** — existente, `OrderStatus`, a nivel de pedido completo.
2. **Estado del ticket de cocina por estación** — nuevo, `kitchen_ticket.status`.
3. **Estado de preparación de cada producto dentro del ticket** — nuevo, más granular, `kitchen_ticket_item.status`.

```prisma
// ILUSTRATIVO — conceptual, no existe en el repo, no se aplica
model preparation_station {
  id          String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  business_id String @db.Uuid
  name        String  // "Parrilla", "Cocina caliente", "Barra", "Postres"
}

model menu_item_station {   // N:N, deliberadamente separado de category_tag
  menu_item_id String @db.Uuid
  station_id   String @db.Uuid
}

model kitchen_ticket {
  id         String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  order_id   String @db.Uuid   // ronda que lo generó
  station_id String @db.Uuid
  status     String  // pending | printed | in_progress | ready | delivered | voided
}

model kitchen_ticket_item {
  id                String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  kitchen_ticket_id String @db.Uuid
  order_item_id     String @db.Uuid
  status            String  // pending | in_progress | ready | voided
}
```

Reglas de diseño:
- Una misma orden con productos de 3 estaciones genera **hasta 3 `kitchen_ticket`** (uno por estación con productos en esa ronda).
- Idempotencia en la generación de comandas: por analogía con `acquireOrderCreateLock` (`checkout.service.ts:85-100`) y con el patrón `claimInvoiceRow`/`decideFromExisting` (`invoice.service.ts:112-215`) — un claim transaccional por `(order_id, station)` con estado `pending/issued/failed` evita duplicados ante reintentos de webhook/cola.
- Reimpresión: operación de lectura idempotente sobre el ticket ya emitido, nunca una re-generación.
- Anulación de un producto ya en preparación: requiere una entidad análoga a `order_item_adjustment` que registre el ajuste sin mutar `order_item` ni `kitchen_ticket_item` original — preserva la misma disciplina de inmutabilidad que ya rige el resto del sistema.

**[PENDIENTE]**: si `category_tag` debe mapear (parcialmente) a estación por defecto, o son conceptos deliberadamente independientes; si un `menu_item` puede pertenecer a más de una estación; si la impresión física es requisito del negocio objetivo o alcanza con pantallas (KDS); quién asigna `menu_item → estación` (dueño del negocio vs. default por categoría).

### 3.3 Pagos y caja

Tres responsabilidades que no deben mezclarse:
- **Cuenta**: cuánto debe el cliente (derivado, nunca cacheado de forma no transaccional).
- **Pago**: cuánto dinero se recibió y se aplicó.
- **Caja**: dónde se registra y concilia ese movimiento — **fuera de alcance de A/B/C**, corresponde a Auditoría D.

```prisma
// ILUSTRATIVO — conceptual, no existe en el repo, no se aplica
model tab_payment {
  id              String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  table_tab_id    String   @db.Uuid
  method          String
  amount_tendered Decimal  @db.Decimal(12, 2)  // lo que efectivamente ENTRÓ
  amount_applied  Decimal  @db.Decimal(12, 2)  // lo aplicado a deuda real (<= tendered)
  status          TabPaymentStatus @default(pending)  // pending|confirmed|failed|reversed
  reversal_of_id  String?  @db.Uuid  // compensación, nunca UPDATE de una fila confirmed
  idempotency_key String   @unique
}

model tab_payment_application {
  tab_payment_id String  @db.Uuid
  order_id       String  @db.Uuid
  amount         Decimal @db.Decimal(12, 2)
}
```

Reglas:
- **Pagos parciales**: N filas `tab_payment` para la misma cuenta, cada una con sus `tab_payment_application` repartidas entre las órdenes con saldo pendiente (FIFO o proporcional — **[PENDIENTE]**, decisión de negocio).
- **Pagos combinados**: dos filas `tab_payment` independientes (ej. $5000 tarjeta + $3500 efectivo), agrupadas por `table_tab_id`.
- **División de cuenta**: vista de cobro sobre ítems/montos asignados a comensales — no particiona `order_item`.
- **Vuelto**: `amount_tendered − amount_applied`, dato derivado que solo interesa a caja física, nunca contamina el saldo de la cuenta.
- **Reversos**: fila nueva con `reversal_of_id` apuntando a la original, signo contrario — **nunca UPDATE/DELETE de una fila `confirmed`**.
- **Devoluciones**: `tab_payment` nueva con `amount_applied` negativo, posiblemente vinculada al ajuste de anulación (`order_item_adjustment`) si el motivo es "se anuló un producto", no "se cobró mal".
- **Saldo pendiente**: `Σ orders.total_amount` del conjunto transitivo de cuentas (resuelto vía `table_tab_merge`) **menos** `Σ tab_payment_application.amount` confirmadas del mismo conjunto. Siempre agregación en consulta, nunca campo cacheado mutado.
- **Fuente de verdad**: `OrderPaymentStatus` (binario, existente) sigue siendo la fuente de verdad operativa de la orden individual, sin tocar su significado. El ledger (`tab_payment_application`) es la fuente de verdad del saldo de **cuenta**; `orders.payment_status` pasa a ser un caché derivado para la orden.

**No asumir** que el estado binario `unpaid|paid` actual puede representar por sí solo pago parcial, combinado o dividido — está confirmado que no puede (`paymentProofChecks.ts:119` exige coincidencia exacta contra el total completo).

### 3.4 Facturación

- Entidad intermedia nueva **`billable_charge`** entre `table_tab` y `fiscal_invoice`: snapshot de qué líneas (de una o varias órdenes) están listas para facturarse, por qué monto y a qué destinatario fiscal — equivalente, para facturación, de lo que `payment_intent` es para pago (una intención con snapshot, no el resultado).
- `fiscal_invoice` se generaliza con `billable_charge_id` nullable paralelo a `order_id` (ambos nunca simultáneamente nulos — requiere CHECK constraint manual, mismo patrón que ya usa el repo en `reservation`, `prisma/schema.prisma:607`). Segundo índice único parcial `@@unique([business_id, billable_charge_id, kind], where: billable_charge_id IS NOT NULL)`.
- `idempotencyKey` se generaliza a `businessId:(orderId|billableChargeId):kind` — mismo contrato, no se rediseña el motor de reclamo (`claimInvoiceRow`/`decideFromExisting`).
- Resuelve: varios comprobantes por cuenta (destinatarios fiscales distintos), facturación parcial (subconjunto de líneas), facturación consolidada (varias órdenes en un comprobante).
- Notas de crédito: siguen siendo `fiscal_invoice{kind: credit_note}` con `reversed_invoice_id` referenciando la original. **No existe hoy el servicio emisor** — el diseño define el modelo, no implementa la emisión. No dar esto por resuelto en ninguna fase.
- Compatibilidad con Sistemas 360: el contrato de red (payload, reintentos, estados `FiscalInvoiceStatus`) **no se toca**; solo se generaliza qué identificador alimenta la clave de idempotencia.

**[PENDIENTE]**: si se permite doble facturación parcial del mismo `order_item` en dos `billable_charge` distintos, o debe bloquearse siempre a nivel de aplicación.

---

## 4. Mapa de dependencias

```
Estado de ocupación de mesa (nuevo, prerrequisito)
        │
        ▼
table_tab + table_tab_table (cuenta ↔ mesas, N:N)
        │
        ├──► orders (rondas) ──► order_item (snapshot inmutable, sin cambios)
        │        │
        │        ├──► generación de kitchen_ticket (1 por estación con productos en la ronda)
        │        │        │
        │        │        └──► menu_item_station (requiere asignación previa producto→estación,
        │        │                independiente de category_tag)
        │        │
        │        └──► order_item_adjustment (anulación post-confirmación, en cualquier capa)
        │
        ├──► tab_payment / tab_payment_application (ledger, saldo derivado)
        │        │
        │        └──► movimientos de caja (Auditoría D — fuera de alcance aquí)
        │
        ├──► billable_charge ──► fiscal_invoice (consolidación/parcial, Sistemas 360 sin cambios de contrato)
        │
        └──► table_tab_merge (unificación por relación, sin tocar orders/tab_payment históricos)
        │
        └──► cierre de cuenta (requiere: saldo = 0 vía ledger, y sin billable_charge en estado `open`)
```

**Justificación de cada dependencia:**
- *Estado de ocupación de mesa → `table_tab`*: sin saber si una mesa está libre, no hay forma de abrir una cuenta sobre ella con sentido operativo. Hoy el campo ni existe.
- *`table_tab` → `orders`/rondas*: una ronda sin agrupador es indistinguible de un pedido de WhatsApp — el agrupador es lo que le da sentido de "ronda de una cuenta" en vez de "pedido aislado".
- *Productos → estaciones → comandas*: no se puede generar un ticket de cocina sin saber a qué estación pertenece cada producto; `category_tag` no sirve para esto (confirmado, es clasificación de menú, no de flujo físico).
- *Consumo → `billable_charge` → facturación*: no se puede facturar una cuenta sin antes decidir qué subconjunto de líneas (de qué órdenes) constituye la obligación fiscal — por eso la entidad intermedia es necesaria antes de tocar `fiscal_invoice`.
- *Cuenta → pagos → saldo → cierre*: el cierre de cuenta depende de un cálculo de saldo consistente, que a su vez depende de que el ledger de pagos ya esté bien definido (parciales, reversos) — cerrar antes de esto dejaría cuentas "cerradas" con deuda mal calculada.
- *Pagos → caja*: cómo se concilia ese dinero (turnos, arqueo, ingresos/egresos) es responsabilidad de la Auditoría D, no de este documento — se declara como dependencia pero no se resuelve aquí.

**Bloqueos identificados (no resolubles independientemente):**
- No se puede implementar comandas sin que exista primero `table_tab` (o al menos `orders.table_tab_id`) — de otro modo no hay "ronda" real a la que atar un ticket.
- No se puede cerrar una cuenta sin que el ledger de pagos (`tab_payment`) ya esté definido con su regla de saldo.
- No se puede resolver facturación consolidada sin `billable_charge`, que a su vez depende de que existan rondas agrupadas por `table_tab`.

---

## 5. Riesgos y decisiones técnicas

### 5.1 Riesgos demostrados (código actual, independientes del diseño futuro)

| Riesgo | Evidencia | Severidad |
|---|---|---|
| Condición de carrera en creación de carrito | `handleDraftOrder` (`src/services/order.service.ts:399-426`): `findFirst`+`create` sin `pg_advisory_xact_lock` ni `@@unique(business_id, customer_phone, status)` sobre `draft_order` | Alto si se multiplica por concurrencia de mozos en salón |
| Máquina de estados de orden sin enforcement | `getNextOrderStatus` (`orderWorkflow.ts:58-74`) definido pero nunca invocado en el PATCH admin — un admin puede saltar/retroceder estados sin validación | Medio |
| Pipeline de `FulfillmentType` con defaults binarios no exhaustivos | Al menos 6 archivos con ternario `TAKE_AWAY : DELIVERY` (ej. `storefrontOrderPush.service.ts`, `publicOrders.service.ts`, `adminOrders.service.ts:117`) — agregar `DINE_IN` caería silenciosamente en el pipeline de delivery si no se auditan uno por uno | Medio-alto al introducir salón |
| Falta de autorización por rol en reservas | `GET /reservations[/:id]` sin `requireRoles`, a diferencia de `tables`/`environments` | **Ya corregido** durante estas auditorías (`src/routes/adminOrders.routes.ts:555-559`) |
| `credit_note` sin servicio emisor | `FiscalInvoiceKind.credit_note` existe en el enum, cero resultados de grep en `src/services/invoicing/*.ts` | Bloquea cualquier diseño de anulación post-facturación hasta que se implemente |
| Sin Row-Level-Security de respaldo para multi-tenant | Aislamiento depende 100% de que cada query futura incluya `business_id` — no hay red de seguridad a nivel de Postgres | Riesgo estructural preexistente, se agrava con cada entidad nueva de salón si no se mantiene la disciplina |

### 5.2 Riesgos de diseño (hipotéticos, propios del modelo futuro — [DISEÑO]/[PENDIENTE])

- Dos mozos editando la misma `table_tab` simultáneamente: sin mecanismo hoy porque la entidad no existe; se recomienda por analogía el mismo patrón de advisory lock usado en `checkout.service.ts`, keyed por `(business_id, table_tab_id)`.
- Reintentos de envío de comanda duplicando tickets: mitigable con el patrón de claim de `invoice.service.ts:112-215` (estado `pending/processing/failed` + ventana de staleness), más apto que el advisory lock de transacción corta para un ticket de vida más larga.
- Doble conteo de saldo si el cálculo derivado y `OrderPaymentStatus` por orden se desincronizan: mitigable si el saldo de cuenta siempre se calcula como función pura sobre filas, nunca como campo cacheado mutado fuera de transacción.
- Doble facturación: mitigable generalizando el mismo mecanismo de idempotencia ya usado hoy (`idempotencyKey` + `@@unique` parcial), nunca relajando la unicidad existente.
- Anulación de producto durante preparación: no existe hoy ningún análogo de `order_item_adjustment` — es diseño nuevo completo, debe decidir explícitamente cómo encadena reversiones en capa operativa → ledger de pago → capa fiscal (nunca al revés).

### 5.3 Contradicciones o imprecisiones detectadas entre los informes originales

Se registran explícitamente, sin resolverlas por intuición:
- La Auditoría A citó el advisory lock de creación de orden como `checkout.service.ts:85-96`; auditorías posteriores (B, C) y la PoC lo citaron como `85-100`. Ambas citas apuntan al mismo bloque real (`acquireOrderCreateLock`); la discrepancia es de rango de líneas citado, no de hecho sustantivo. **No afecta ninguna conclusión**, se deja registrado por transparencia.
- La Auditoría A citó la creación de `orders`+`order_item` como `checkout.service.ts:265-297`; la Auditoría C la citó como `286-347`. Mismo bloque funcional (creación de la orden dentro de `createOrderFromDraftLocked`), con rangos de línea algo distintos entre pasadas — **no verificado cuál es el rango exacto actual sin una relectura línea por línea del archivo en este momento**; se recomienda que la próxima auditoría que toque este archivo confirme el rango exacto antes de citarlo en un documento normativo.
- El PoC (pasada 2) mencionó inicialmente `order_item_adjustment` como si ya tuviera cierto antecedente; la Auditoría C aclaró explícitamente que esa entidad **no existe en ningún lado del código actual** y que es una propuesta nueva sin precedente real — se adopta esta última aclaración como correcta en este documento.

---

## 6. Temas pendientes de auditorías D y E

Explícitamente fuera de alcance de A, B y C — no se intenta responder aquí.

### Auditoría D — Caja, pagos y cierre operativo
- Apertura y cierre de caja, turnos y responsables.
- Ingresos y egresos no ligados a una cuenta de cliente.
- Medios de pago soportados físicamente (terminal de tarjeta, efectivo, QR) y su conciliación.
- Arqueos y diferencias de caja.
- Cómo los reversos/devoluciones de `tab_payment` (definidos conceptualmente en §3.3) se reflejan en un cierre de turno.
- Cuentas con saldo pendiente al cierre de turno (¿bloquean el cierre de caja, o quedan "abiertas" para el turno siguiente?).
- Integración entre el ledger de pagos de salón y la facturación.

### Auditoría E — Infraestructura operativa, seguridad y tiempo real
- Roles reales de mozo/cajero/encargado (hoy solo existen OWNER/ADMIN/STAFF/DELIVERY a nivel de código, confirmado en la auditoría de seguridad de `/reservations` — no hay rol específico de mozo/cajero verificado).
- Permisos por operación en el futuro POS (quién puede abrir/cerrar cuenta, aplicar pago, anular producto).
- Concurrencia multiusuario más allá de lo ya señalado en §5.2.
- Extensión real de `admin:order`/`adminSocket.ts` (o canal nuevo) para mesas/comandas en tiempo real — hoy no existe ningún `emitAdminTable*`.
- Reconexión y recuperación de sesión de dispositivos en salón.
- Auditoría de acciones (quién hizo qué, cuándo) — hoy `orders.update` no registra autoría de quién cambió el estado desde el panel admin.
- Arquitectura de `gesty-admin` (Next.js) y su capacidad real de multidispositivo (tablets de mozo, pantallas de cocina).
- KDS e impresión térmica: confirmado que no hay ninguna dependencia ni integración hoy (`package.json` sin librerías de impresión).

---

## 7. Propuesta preliminar de fases

> Preliminar: no se cierra el roadmap definitivo hasta completar D y E. Las fases siguen la dependencia estructural de §4: primero base de cuentas/mesas, luego cocina y pagos de salón, luego facturación presencial.

### Fase 0 — Cimientos de ocupación y cuenta
- **Objetivo funcional**: saber si una mesa está libre/ocupada y poder abrir una cuenta sobre ella.
- **Incorpora**: estado de ocupación de mesa (derivado de si tiene una `table_tab` abierta vinculada), `table_tab`, `table_tab_table`.
- **Dependencias previas**: ninguna — es la base.
- **Entidades**: `table` (existente, sin cambios de esquema salvo lo que requiera el derivado), `table_tab`, `table_tab_table`.
- **Riesgos principales**: concurrencia al abrir cuenta/asignar mesa (mitigar con advisory lock por mesa); la condición de carrera ya conocida de `handleDraftOrder` se agrava si el flujo de salón reutiliza ese camino sin resolverlo antes.
- **Criterio verificable de cierre**: puede abrirse una cuenta sobre una mesa libre, queda bloqueada para otra cuenta `open` simultánea (constraint real, no solo a nivel de aplicación), y puede cerrarse liberando la mesa.

### Fase 1 — Rondas ligadas a cuenta
- **Objetivo funcional**: que un pedido de salón sea una ronda de una cuenta, no un pedido aislado.
- **Incorpora**: `orders.table_tab_id` (nullable), `FulfillmentType.DINE_IN` (solo tras auditar los usos existentes del enum, ver §5.1), pipeline de `OrderStatus` propio para salón (sin `shipped`).
- **Dependencias previas**: Fase 0.
- **Entidades**: `orders` (campo nuevo), `orderWorkflow.ts` (pipeline nuevo).
- **Riesgos principales**: romper silenciosamente delivery/take-away si no se auditan los ~6+ archivos con defaults binarios sobre `FulfillmentType`.
- **Criterio verificable de cierre**: se pueden crear N rondas sucesivas sobre la misma cuenta sin que cada una exija checkout/pago individual, y el pipeline de delivery/take-away sigue pasando su suite de tests sin modificación.

### Fase 2 — Ledger de pagos de salón
- **Objetivo funcional**: cobrar una cuenta con pagos parciales, combinados o divididos.
- **Incorpora**: `tab_payment`, `tab_payment_application`, cálculo de saldo derivado, regla de cierre de cuenta (saldo = 0).
- **Dependencias previas**: Fase 1 (necesita rondas/órdenes reales contra las que aplicar pagos).
- **Entidades**: `tab_payment`, `tab_payment_application`.
- **Riesgos principales**: doble conteo si el saldo derivado se desincroniza de `OrderPaymentStatus` por orden; reversos mal modelados rompiendo la inmutabilidad de pagos confirmados.
- **Criterio verificable de cierre**: una cuenta con 2 rondas puede recibir 2 pagos parciales de medios distintos y cerrar con saldo exactamente 0, con reverso de un pago mal cobrado sin editar la fila original.

### Fase 3 — Comandas y estaciones
- **Objetivo funcional**: que cocina reciba solo los productos que le corresponden, con estado propio.
- **Incorpora**: `preparation_station`, `menu_item_station`, `kitchen_ticket`, `kitchen_ticket_item`, canal de notificación (extensión de `adminSocket.ts` o nuevo).
- **Dependencias previas**: Fase 1 (necesita rondas reales que generen comandas).
- **Entidades**: las cuatro nuevas + extensión de socket.
- **Riesgos principales**: duplicación de tickets ante reintentos (mitigar con claim idempotente); anulación de producto ya en preparación sin mecanismo definido.
- **Criterio verificable de cierre**: una ronda con productos de 2 estaciones genera 2 tickets independientes, cada uno con su propio ciclo de estado, sin duplicarse ante un reintento simulado.

### Fase 4 — Facturación presencial consolidada
- **Objetivo funcional**: facturar una cuenta de salón (parcial o consolidada) sin romper la facturación de e-commerce existente.
- **Incorpora**: `billable_charge`, extensión de `fiscal_invoice` (`billable_charge_id` nullable + segundo índice único parcial), generalización de `idempotencyKey`.
- **Dependencias previas**: Fase 2 (necesita saldo/pagos reales para saber qué facturar y por qué monto).
- **Entidades**: `billable_charge`, `fiscal_invoice` (extendida).
- **Riesgos principales**: doble facturación si no se preserva la unicidad; notas de crédito sin servicio emisor real (bloqueante ya identificado, no resuelto por esta fase).
- **Criterio verificable de cierre**: una cuenta con 3 rondas puede facturarse en un único comprobante consolidado, o en dos comprobantes parciales para dos destinatarios fiscales distintos, sin violar ningún `@@unique`.

### Fase 5 — Unificación/transferencia avanzada (merge, split, transferencia de mesa)
- **Objetivo funcional**: operaciones de mozo de uso frecuente pero no bloqueantes para un primer lanzamiento mínimo.
- **Incorpora**: `table_tab_merge`, `table_tab_split` (si se decide persistir), transferencia de mesa con historial.
- **Dependencias previas**: Fases 0-2 (necesita cuentas y pagos ya funcionando).
- **Riesgos principales**: unificar cuentas con pagos parciales ya aplicados — regla de negocio aún pendiente (§3, PoC pasada 3).
- **Criterio verificable de cierre**: dos cuentas con historial propio (órdenes y pagos) pueden fusionarse sin reescribir ninguna fila histórica, y el saldo consolidado resultante es verificable por el ejemplo numérico de §3.1.1.

**No convertir esta secuencia en backlog de tareas de código** — cada fase requiere su propio diseño técnico detallado antes de implementarse, y ninguna debe iniciarse antes de que D y E resuelvan sus propios pendientes relevantes (caja para Fase 2 y 4; roles/tiempo real para Fase 3 y 5).

---

## 8. Glosario de entidades y conceptos

| Término | Definición en este documento |
|---|---|
| **Pedido / ronda** (`orders`) | Unidad de venta inmutable una vez confirmada. En salón, cada ronda de una mesa es una `orders` nueva. |
| **Cuenta** (`table_tab`, [DISEÑO]) | Agrupador de consumo de una mesa/atención presencial; agrupa N rondas hasta su cierre. |
| **Comanda** (`kitchen_ticket`, [DISEÑO]) | Ticket de trabajo para una estación de cocina, generado a partir de una ronda. |
| **Estación** (`preparation_station`, [DISEÑO]) | Sector físico de preparación (parrilla, barra, postres...). Independiente de `category_tag`. |
| **Venta / obligación facturable** (`billable_charge`, [DISEÑO]) | Snapshot de qué líneas, de qué órdenes, por qué monto, está listo para generar un comprobante fiscal. |
| **Pago** (`tab_payment`/`payment_intent`/`payment_proof`) | Dinero recibido. `payment_intent`/`payment_proof` son del núcleo e-commerce existente (1 pedido = 1 pago); `tab_payment` es el ledger nuevo de salón (parcial/combinado). |
| **Aplicación de pago** (`tab_payment_application`, [DISEÑO]) | Asignación de un pago (o parte de él) a una orden específica dentro de una cuenta. |
| **Caja** | Turno, arqueo, ingresos/egresos — **no auditado aquí**, corresponde a Auditoría D. Distinto de "pago": un pago es un hecho económico puntual; la caja es su conciliación operativa. |
| **Mesa** (`table`) | Recurso físico existente, con layout y capacidad, sin estado de ocupación hoy. |
| **Reserva** (`reservation`) | Expectativa futura de visita, gestionada hoy por el bot de WhatsApp. No equivale a mesa ocupada. |

---

## 9. Referencias concretas (archivos/líneas citados en este documento)

- `prisma/schema.prisma`: `orders`/`order_item` (~442-481/425-440), `payment_intent` (~871-897), `payment_proof` (~979-1008), `table`/`environment`/`reservation`/`reservation_table`/`reservation_block` (~592-682), `OrderStatus`/`FulfillmentType`/`OrderPaymentStatus` (~1011-1035), `fiscal_invoice`/`FiscalInvoiceKind` (~1125-1164/1063-1066), `menu_category`/`MenuCategoryTag` (~260-274/1038-1047).
- `src/services/checkout.service.ts`: advisory lock (~85-100) y creación de `orders`+`order_item` (~265-347, rango citado con discrepancia menor entre auditorías, ver §5.3).
- `src/services/order.service.ts:399-426` — `handleDraftOrder`, condición de carrera conocida.
- `src/constants/orderWorkflow.ts:58-74` — `getNextOrderStatus`, sin invocación real.
- `src/services/payment/paymentProofChecks.ts:44-51,119` — validación de monto exacto.
- `src/services/invoicing/invoice.service.ts:52-54,112-215` — idempotencia y motor de reclamo de facturación.
- `src/socket/adminSocket.ts` — eventos `admin:order`/`admin:reservation`, sin equivalente de mesas.
- `src/routes/adminOrders.routes.ts:555-559` — corrección de autorización aplicada (`requireRoles("OWNER","ADMIN")` en rutas de reservas).
- `gesty-admin` (repo hermano, Next.js) — `contexts/admin-socket-context.tsx`, consumidor de `admin:order`; sin ninguna pantalla de cocina/KDS.

---

## Confirmación de alcance

Este documento es exclusivamente de síntesis y documentación. No se modificó ningún archivo del proyecto salvo la creación de este mismo documento (`docs/arquitectura/POS_MASTER_SPEC.md`). No se tocó código, schema de Prisma, migraciones, endpoints, servicios ni configuración.
