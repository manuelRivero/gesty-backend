# Auditoría de solo lectura — Sabrosón como restaurante de demostración de Gesty POS

> **Alcance**: auditoría exclusivamente de lectura. No se modificó código, no se modificaron registros, no se ejecutaron migraciones, no se disparó ningún pago, factura, notificación ni script de escritura (incluido `scripts/dedupe-sabroson-menu.ts`, que existe en el repo pero no fue ejecutado).
>
> **Entorno verificado**: `business_id = e89dfb88-a409-4818-a01e-37d7d5ba2e11`, negocio "Sabrosón" (`slug=sabroson`). Antes de consultar datos se confirmó que `NODE_ENV=development` carga `.env.development` (vía `src/config/loadEnv.ts`), cuyo `DATABASE_URL` apunta al host Neon `ep-red-credit-a43tq2vb.us-east-1.aws.neon.tech`. El usuario confirmó explícitamente que esta es la base de datos de desarrollo. Se detectó además que el archivo `.env` (no `.env.development`) contiene **dos bloques `DATABASE_URL` distintos y sin comentar** (uno a un Postgres local `food-postgres` y otro a un segundo proyecto Neon `ep-mute-smoke-a4m3xtak`), y que algunos scripts sueltos del repo (p. ej. `scripts/_tmp_list-sabroson-dups.ts`, que usa `import 'dotenv/config'` antes de cargar Prisma) pueden terminar apuntando a ese segundo Neon en vez de al de `.env.development`, según el orden de imports. Esto se documenta como riesgo en la sección 7.
>
> Todas las consultas se hicieron con Prisma (`findMany`/`findUnique`/`groupBy`) desde scripts temporales fuera del repo. No se expone en este informe ningún CUIT, email, teléfono completo, token, contraseña ni cadena de conexión completa.

## 1. Resumen ejecutivo

Sabrosón **existe, está activo y tiene datos reales de uso** (138 sesiones de usuario, 42 pedidos históricos, 10 reservas, pagos ya procesados). Sin embargo, hoy es el entorno de un **bot conversacional de WhatsApp + storefront + reservas + delivery/pickup**, no un POS de salón. Tres hallazgos dominan la auditoría:

1. **[HECHO] No existe ningún vínculo entre una mesa y un pedido.** `orders` no tiene `table_id`; las mesas (`table`) solo se relacionan con `reservation`. No hay "abrir cuenta", consumo acumulado, ni transferencia/unión de mesas. Construir esto es trabajo de diseño desde cero.
2. **[RIESGO CRÍTICO] El proveedor de pagos de Sabrosón (Mercado Pago) está configurado en modo real, no sandbox** (`is_sandbox: false`). Cualquier prueba que complete un checkout online puede generar **un cobro de dinero real**, y ese cobro dispara automáticamente la emisión de un comprobante fiscal (aunque el lado fiscal sí está en sandbox de Sistemas 360, por lo que no sería un comprobante real ante AFIP).
3. **[HECHO] No existe ningún sistema de cocina/comandas.** Los estados `preparing`/`ready_for_pickup` son estados de pedido completo (heredados del flujo take-away/delivery), no de comanda ni de producto. No hay estaciones, KDS, impresión ni estado por ítem.

Además, el catálogo de menú y las mesas de Sabrosón tienen **datos de seed duplicados y sin limpiar** (catálogo duplicado ~50%, mesas y horarios con filas repetidas), y no existen roles de mozo/cocina/cajero en el sistema de permisos (solo `OWNER`, `ADMIN`, `STAFF`, `DELIVERY`, `SUPER_ADMIN`).

**Conclusión**: Sabrosón es reutilizable como base de demo (negocio real, menú con buena variedad una vez deduplicado, usuarios reales), pero **no se puede ejecutar hoy una demo de salón de punta a punta sin desarrollo nuevo**, y **no se puede ejercitar un pago online en pruebas sin riesgo de dinero real** hasta que se resuelva el modo sandbox de Mercado Pago.

## 2. Identificación del entorno y del negocio

- [HECHO] Entorno: Neon (desarrollo), confirmado por el usuario y por el código de carga de variables (`src/config/loadEnv.ts`). Host: `ep-red-credit-a43tq2vb...neon.tech` (comentado en `.env.development` como "Neon develop + Stripe test").
- [HECHO] `business.id = e89dfb88-a409-4818-a01e-37d7d5ba2e11`, `name="Sabrosòn"`, `slug="sabroson"`, `is_active=true`, `category="HOME_MADE"`, `currency_code="ARS"`, `billing_mode="subscription"`, `ai_plan="basic"`. Modelo `business` (`prisma/schema.prisma:10-71`).
- [HECHO] `subscription.status="active"` pero `current_period_end=2026-10-02`, ya vencido respecto a hoy (2026-11-08). [PENDIENTE] no se auditó si esto bloquea algo en runtime.
- [RIESGO — documentado, no explotado] `.env` tiene dos `DATABASE_URL` sin comentar apuntando a destinos distintos de `.env.development`; algunos scripts ad-hoc del repo pueden cargar el equivocado según el orden de sus imports. Antes de dar acceso a terceros a "la" base de desarrollo, conviene unificar esto.

## 3. Configuración real de Sabrosón

### Canales de venta (`business_config`, `prisma/schema.prisma:713-753`)
- [HECHO] Habilitados: `bot_enabled`, `storefront_enabled`, `orders_enabled`, `checkout_enabled`, `reservations_enabled`, `takeaway_enabled`, `external_delivery_enabled`. Deshabilitado: `delivery_enabled` (propio), `ambassadors_enabled`.
- [HECHO] **No existe ningún concepto de "venta en salón/mostrador/POS presencial"** en el modelo de canales. Los únicos canales modelados son bot WhatsApp, storefront web, pickup y delivery (propio o externo).

### Reservas
- [HECHO] `reservation_config` (`prisma/schema.prisma:684-697`): `is_enabled=true`, `slot_duration_minutes=120`, `allow_table_combination=true`, `max_party_size=12`, `max_days_ahead=15`.
- [HECHO] **Existen dos fuentes de configuración de reservas en conflicto** para el mismo negocio: `business_config.reservation_*` (p. ej. `reservation_default_duration_minutes=60`) vs. `reservation_config.slot_duration_minutes=120`. [RECOMENDACIÓN] determinar cuál consume realmente el motor de reservas en runtime antes de apoyarse en estos valores para diseñar el POS de salón.

### Pagos
- [HECHO] `business_payment_provider`: un solo proveedor activo, `mercado_pago`, **`is_sandbox=false`** (producción real).
- [HECHO] `payment_method_config`: `cash` inactivo, `online` activo, `transfer` activo (con instrucciones de mandar comprobante por chat). El efectivo, que sería el método natural de un cobro de salón, está deshabilitado hoy.

### Facturación
- [HECHO] `fiscal_configuration`: `status="validated"`, `condicion_iva="MONOTRIBUTO"`, `auto_issue_online=true`, `auto_issue_cash=false`, **`external_issuer_environment="sandbox"`** (Sistemas 360), validado el 2026-11-05.
- [HECHO] `invoicing_addon.enabled=true`, sin límite mensual definido.
- [HECHO] `fiscal_invoice`: 0 registros — nunca se emitió ni intentó emitir un comprobante para Sabrosón.

### Salón, mesas y operación presencial
- [HECHO] 2 `environment` ("Salón principal", "Patio exterior"), 11 `table` (todas en Salón principal), con **nombres duplicados** ("Mesa 4/5/6" x2 con distinto id) y una fila literal `"mesa de prueba"` — evidencia de datos de seed sin limpiar, no de un layout curado. `business_hours` también tiene filas duplicadas por día de la semana.

### Feature flags
- [HECHO] `business.features = {}` (vacío). No hay código en `src/` que lea claves específicas de esta columna — es un campo reservado sin consumo real hoy.
- [DISEÑO] No existe ningún flag tipo `pos_enabled`/`dine_in_enabled`. Habría que crearlo para aislar el futuro modo salón del resto de canales.

## 4. Inventario de datos disponibles

| Dominio | Cantidad | Estado / observación |
|---|---|---|
| Ambientes (`environment`) | 2 | Salón principal (con mesas), Patio exterior (sin mesas) |
| Mesas (`table`) | 11 | Nombres duplicados + 1 "mesa de prueba" |
| Reservas (`reservation`) | 10 | 8 `closed`, 2 `confirmed`; 0 `reservation_block` |
| Categorías de menú (`menu_category`) | 23 filas / **11 nombres reales** | 10 nombres duplicados (seed corrido 2 veces el 2026-02-21) |
| Productos (`menu_item`) | 201 filas / **~104 únicos reales** | 97 nombres duplicados exactos; 100 `is_available=true`, 101 `false`, inconsistente entre duplicados |
| Precios (`menu_item_price`) | 151/201 con precio | 50 ítems (25%) sin ningún precio cargado |
| Promociones (`promotion`) | 0 | Modelo completo existe, pero "no hay motor de descuentos" (comentario explícito en el schema) |
| Usuarios (`business_user`) | 4 | 1 OWNER, 1 ADMIN, 1 STAFF, 1 DELIVERY — con 138 sesiones históricas (uso real) |
| Pedidos (`orders`) | 42 | `delivered`(14, 12 pagados), `cancelled`(11), `placed`(8), `preparing`(5), `draft`(3), `shipped`(1) |
| Intentos de pago (`payment_intent`) | 2 | Ambos `mercado_pago`, `approved`, en proveedor **no sandbox** |
| Comprobantes fiscales (`fiscal_invoice`) | 0 | Nunca emitido |

## 5. Capacidades existentes

- [HECHO] Panel admin con gestión de floor-plan de mesas (`src/services/adminTables.service.ts`), reservas con asignación/combinación de mesas (`src/repositories/reservation.repository.ts`), gestión de pedidos, promociones y configuración (`src/routes/adminOrders.routes.ts`).
- [HECHO] Bot conversacional de WhatsApp con reservas, menú, pedidos de pickup/delivery (flujo maduro, con evidencia de uso real: instrucciones de pickup personalizadas, 42 pedidos, 10 reservas).
- [HECHO] Panel en tiempo real vía Socket.IO para pedidos y reservas (`src/socket/adminSocket.ts`), reutilizable como patrón (no como datos) para un futuro canal de cocina.
- [HECHO] Facturación electrónica con aislamiento sandbox/producción ya diseñado explícitamente a nivel de negocio (`fiscal_configuration.external_issuer_environment`).
- [HECHO] Roles y control de acceso por rutas (`requireRoles`, `src/middleware/auth.middleware.ts`) para OWNER/ADMIN/SUPER_ADMIN.

## 6. Brechas funcionales

| Brecha | Estado | Evidencia |
|---|---|---|
| Vínculo mesa ↔ pedido / apertura de cuenta / consumo acumulado / transferencia de mesas | [DISEÑO] inexistente | `orders` sin `table_id`; sin código de "open tab" |
| Estado de ocupación física de mesa (libre/ocupada/en cuenta) | [DISEÑO] inexistente | `table` solo tiene campos de floor-plan e `is_active` |
| Fulfillment "dine-in"/salón | [DISEÑO] inexistente | `FulfillmentType` solo tiene `DELIVERY`/`TAKE_AWAY` |
| Roles de mozo, cocina, cajero | [DISEÑO] inexistentes | `BUSINESS_USER_ROLES` = `SUPER_ADMIN, OWNER, ADMIN, STAFF, DELIVERY` (`src/types/auth.ts`) |
| Sistema de comandas/KDS, estado por ítem, estaciones, impresión | [DISEÑO] inexistente | Sin modelos ni código relacionado (búsqueda exhaustiva sin resultados) |
| Modificadores/adicionales con precio propio | [DISEÑO] inexistente | Solo `menu_item.variations` (variación de nombre, mismo precio); usado en 1/201 ítems |
| Modo sandbox de pagos para Sabrosón | [PENDIENTE] decisión/config | `business_payment_provider.is_sandbox=false` |
| Catálogo y mesas sin duplicar | [PENDIENTE] limpieza de datos | Ver sección 4 |

## 7. Riesgos de aislamiento y seguridad

1. **[RIESGO CRÍTICO]** Proveedor de pagos de Sabrosón en modo real (`is_sandbox=false`). Completar un checkout online en una prueba puede generar un **cobro real** de dinero. Ya hay 2 `payment_intent` `approved` en ese proveedor real (origen no verificable sin acceso al dashboard de Mercado Pago, fuera de alcance de esta auditoría).
2. **[RIESGO MEDIO, encadenado]** Un cobro online confirmado dispara automáticamente (`src/services/payment/payment.service.ts:694`, función `triggerAutomaticInvoiceEmission`) la emisión de un comprobante fiscal. El emisor está en sandbox de Sistemas 360, por lo que **no sería un comprobante real ante AFIP**, pero sí consume el `invoicing_addon` (sin límite mensual definido) y deja registros en `fiscal_invoice`.
3. **[RIESGO BAJO]** No hay riesgo de efectos de cocina porque no existe ningún automatismo de cocina que disparar.
4. **[RIESGO — ambigüedad de entorno]** El archivo `.env` (distinto de `.env.development`) contiene dos `DATABASE_URL` sin comentar apuntando a destinos diferentes entre sí y distintos del Neon "develop" confirmado. Algunos scripts sueltos del repo pueden cargar accidentalmente el equivocado según su orden de imports (`dotenv/config` vs. `loadEnv()`). [RECOMENDACIÓN] limpiar `.env` para que solo contenga un `DATABASE_URL`, o documentar claramente cuál es cuál.
5. **[OBSERVACIÓN, fuera del foco de datos de negocio]** El archivo `.env` tiene permisos `777` (`-rwxrwxrwx`) en el filesystem local. No se auditaron permisos de infraestructura en profundidad; se deja como nota para quien gestione el entorno.

## 8. Escenarios de demostración y su viabilidad

| # | Escenario | Estado | Soporte actual | Falta | Dependencia | Riesgo al implementar |
|---|---|---|---|---|---|---|
| 1 | Admin visualiza el salón | **Disponible** | Floor-plan admin (`adminTables.service.ts`) | — | — | Ninguno |
| 2 | Mozo identifica una mesa libre | **Inexistente** | No hay estado de ocupación física, ni rol mozo | Modelo de estado de mesa + rol | Escenario 1 | Bajo (solo desarrollo) |
| 3 | Mozo abre una cuenta | **Inexistente** | — | Entidad `table_session`/tab | Escenario 2 | Medio (define el modelo central del POS) |
| 4 | Mozo registra una primera ronda | **Parcialmente disponible** | `orders`/`order_item` existen para pickup/delivery | Vínculo orden↔mesa/cuenta, fulfillment "dine-in" | Escenario 3 | Medio |
| 5 | Cocina recibe la comanda | **Inexistente** | Nada (ver Auditoría F) | Modelo de comanda + estado por ítem + canal en tiempo real | Escenario 4 | Alto (mayor pieza nueva) |
| 6 | Cocina actualiza estado de preparación | **Inexistente** | — | Igual que 5 | Escenario 5 | Alto |
| 7 | Mozo agrega segunda ronda a la misma cuenta | **Inexistente** | — | Igual que 3/4, más lógica de acumulación | Escenario 3 | Medio |
| 8 | Caja consulta consumo acumulado | **Inexistente** | — | Cálculo sobre la cuenta (depende de 3) | Escenario 3 | Bajo una vez exista 3 |
| 9 | Cliente realiza un pago | **Parcialmente disponible, con riesgo** | Flujo de pago online/efectivo/transferencia ya existe para pickup/delivery | Adaptarlo a "pago de cuenta de salón"; **resolver sandbox de Mercado Pago antes de probarlo** | Riesgo crítico sección 7 | Alto si se usa el proveedor real |
| 10 | Caja cierra la cuenta | **Inexistente** | — | Transición de estado de la cuenta a cerrada | Escenario 3, 9 | Medio |
| 11 | La mesa vuelve a estar disponible | **Inexistente** | — | Transición de estado de mesa a libre | Escenario 2, 10 | Bajo |

No se simula que ningún escenario del 2 al 11 (salvo el 4 y 9 parcialmente, apoyados en el motor de pedidos/pagos existente) tenga soporte real por la mera existencia de tablas relacionadas (p. ej. `table`, `orders`): se verificó específicamente la ausencia de FK y de código operativo para cada caso.

## 9. Dependencias con las Auditorías A, B y C

- El escenario de demo (sección 8) depende íntegramente de los hallazgos de **B** (ausencia de vínculo mesa↔pedido) y **D** (ausencia de roles de mozo/cocina/cajero, cubierta junto con A).
- La viabilidad de una demo de menú "limpia" depende de resolver la duplicación encontrada en **C** antes de cualquier presentación.
- La configuración de pagos/facturación de **A** y el detalle de riesgo de **E** son la misma pieza de evidencia vista desde dos ángulos (configuración vs. riesgo operativo); se mantienen consistentes entre sí.

## 10. Recomendaciones para convertir Sabrosón en restaurante de demostración

1. **[RECOMENDACIÓN — antes que nada]** Resolver el modo de pagos: pasar `business_payment_provider` de Sabrosón a `is_sandbox=true` con credenciales de test de Mercado Pago, o evitar por completo el camino de pago online en las demos hasta entonces.
2. **[RECOMENDACIÓN]** Limpiar datos de seed duplicados: ejecutar (en un momento aparte, controlado, no como parte de esta auditoría) `scripts/dedupe-sabroson-menu.ts --execute`, deduplicar `menu_category` (el script actual no lo cubre), y limpiar las mesas y `business_hours` duplicados.
3. **[DISEÑO]** Diseñar el modelo central faltante: una entidad de "cuenta/sesión de mesa" (`table_session`/tab) que vincule `table` ↔ una o más `orders`, con estado de ocupación propio, independiente de `reservation`.
4. **[DISEÑO]** Agregar un tipo de fulfillment "dine-in"/salón a `FulfillmentType`, y roles `WAITER`/`KITCHEN`/`CASHIER` a `BUSINESS_USER_ROLES` con sus `requireRoles(...)` correspondientes.
5. **[DISEÑO]** Diseñar desde cero el sistema de comandas: estado por `order_item` (o entidad `kitchen_ticket_item`), noción de estación, y un canal de Socket.IO dedicado a cocina (reutilizando el patrón de `adminSocket.ts`).
6. **[PENDIENTE]** Decidir si las demos de pago deben recorrer el ciclo completo (requiere sandbox real) o si se introduce un "modo demo" que desactive `triggerAutomaticInvoiceEmission` y cualquier proveedor de pago real durante la presentación.
7. **[RECOMENDACIÓN]** Unificar `.env` para que no contenga `DATABASE_URL` ambiguos, reduciendo el riesgo de que un script apunte por error a un entorno distinto del confirmado.

## Partes no verificables en esta auditoría

- No se pudo confirmar, sin acceso al dashboard de Mercado Pago (fuera de alcance de una auditoría de solo lectura sobre la base de datos), si los 2 `payment_intent` `approved` corresponden a cobros reales efectivamente liquidados o a pruebas manuales previas con montos bajos.
- No se auditó en profundidad qué permisos efectivos tiene un usuario `STAFF` dentro del panel admin más allá de los gates explícitos de ruta (ver nota de alcance en Auditoría D).
- No se verificó si el vencimiento de `subscription.current_period_end` (2026-10-02) bloquea alguna funcionalidad en runtime.
- No se abrieron las URLs de imágenes de productos para evaluar su calidad visual real.
