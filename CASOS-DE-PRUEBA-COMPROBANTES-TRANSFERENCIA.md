# Casos de prueba manual — Comprobantes de transferencia bancaria

Verificación contra el bot real (WhatsApp Cloud API + panel admin), Fases 1-5
de `PLAN-ACCION-COMPROBANTES-TRANSFERENCIA.md`. Ejecutar en este orden; cada
caso asume que el anterior dejó el sistema en un estado limpio salvo que se
indique lo contrario.

**Precondiciones:**
- `WHATSAPP_ACCESS_TOKEN`, `R2_*` configurados en el entorno donde corre el bot.
- Un negocio con el método de pago `transfer` activo en `payment_method_config`,
  con `instructions` cargadas (CBU/alias de prueba).
- Acceso al panel admin con un usuario `OWNER` o `ADMIN`.

---

## Caso 1 — Comprobante dentro de ventana (happy path)

1. Desde WhatsApp, hacer un pedido y elegir "Transferencia" como método de pago.
2. Confirmar el pedido.
3. **Verificar:** el mensaje de confirmación incluye la invitación a mandar el
   comprobante por el chat (Tarea 4.2), además de las instrucciones del local.
4. Mandar una foto (JPEG o PNG) por el mismo chat, dentro de las 24 horas
   siguientes (`TRANSFER_PROOF_WINDOW_HOURS`).
5. **Verificar:**
   - El bot responde con un mensaje de recepción que **no afirma que el pago
     está confirmado** (D3).
   - En la tabla `payment_proof` aparece una fila nueva con `status='received'`,
     `order_id` apuntando al pedido del paso 1, `media_url` accesible
     públicamente, y `checks.image_not_reused = 'pass'`.
   - El panel admin recibe el evento de socket `order.payment_proof_received`
     (revisar consola del navegador o el indicador de notificación, si existe).

## Caso 2 — Imagen sin orden pendiente

1. Con el mismo cliente del Caso 1 (o uno sin pedidos de transferencia
   impagos), mandar una foto cualquiera por WhatsApp sin haber hecho un
   pedido con transferencia pendiente.
2. **Verificar:**
   - El bot responde con el aviso genérico "No puedo procesar este tipo de
     mensaje" + botón "Pedir ayuda".
   - No se crea ninguna fila en `payment_proof`.
3. Repetir mandando un audio, un video y un sticker en vez de imagen.
4. **Verificar:** en los tres casos el resultado es el mismo aviso genérico,
   sin excepción (audio/video/sticker/documento nunca pasan el guard,
   tengan o no orden pendiente).

## Caso 3 — Comprobante duplicado (reuso de imagen)

1. Hacer un segundo pedido por transferencia con el mismo cliente (o uno
   distinto del mismo negocio).
2. Mandar **la misma foto** ya usada en el Caso 1 como comprobante de este
   nuevo pedido.
3. **Verificar:**
   - El bot igual responde con el mensaje de recepción normal (D6: el reuso
     **no** bloquea la creación del proof).
   - La nueva fila de `payment_proof` tiene `checks.image_not_reused = 'fail'`
     y `checks.image_reused_in_order_id` apuntando a la orden del Caso 1.

## Caso 4 — Aprobación desde el admin

1. Ir al panel admin → pedido del Caso 1 → ver comprobantes
   (`GET /orders/:id/payment-proofs`).
2. **Verificar:** se ve la imagen subida en el Caso 1, con su `status='received'`.
3. Aprobar el comprobante (`POST /orders/:id/payment-proofs/:proofId/review`
   con `{ decision: 'approve' }`).
4. **Verificar:**
   - El pedido pasa a `payment_status='paid'`.
   - El comprobante queda en `status='approved'`, con `reviewed_by` (el admin
     que aprobó) y `reviewed_at` completos.
   - Se emite `order.payment_status_changed` (mismo evento que el resto del
     flujo de pagos — no hay uno nuevo para esto).

## Caso 5 — Rechazo desde el admin

1. Tomar el comprobante del Caso 3 (el duplicado).
2. Rechazarlo con una nota (`{ decision: 'reject', note: 'Comprobante repetido, no corresponde a este pedido' }`).
3. **Verificar:**
   - El comprobante queda en `status='rejected'`, con la nota guardada en
     `review_note`.
   - El pedido correspondiente **sigue** en `payment_status='unpaid'` (el
     rechazo no lo toca).

## Caso 6 — Aislamiento por negocio

1. Con un usuario admin de un negocio B, intentar ver o revisar un
   comprobante que pertenece a un pedido del negocio A (Caso 1).
2. **Verificar:** la API responde `404` (comprobante/orden no encontrada),
   nunca `403` — no debe filtrar que el recurso existe en otro negocio.

## Caso 7 — Dos órdenes de transferencia impagas simultáneas

1. Con el mismo cliente, generar dos pedidos por transferencia sin resolver
   (ninguno aprobado ni rechazado).
2. Mandar un comprobante por WhatsApp.
3. **Verificar:** el comprobante queda asociado a la orden **más reciente**
   de las dos (D1 — no hay desambiguación con el cliente). Si corresponde al
   pedido viejo, reasignarlo manualmente desde el admin (fuera del alcance
   automatizado de este plan).

## Caso 8 — Ventana vencida

1. Con una orden de transferencia impaga de hace más de
   `TRANSFER_PROOF_WINDOW_HOURS` (24hs por default) — se puede simular
   ajustando `created_at` en la base para un pedido de prueba.
2. Mandar una imagen por WhatsApp.
3. **Verificar:** el bot responde con el aviso genérico (mismo comportamiento
   que el Caso 2) — la orden vencida no cuenta como "esperando comprobante".

---

## Registro de resultados

| # | Caso | Resultado | Fecha | Notas |
|---|------|-----------|-------|-------|
| 1 | Comprobante dentro de ventana | ⬜ | | |
| 2 | Imagen sin orden pendiente | ⬜ | | |
| 3 | Comprobante duplicado | ⬜ | | |
| 4 | Aprobación desde el admin | ⬜ | | |
| 5 | Rechazo desde el admin | ⬜ | | |
| 6 | Aislamiento por negocio | ⬜ | | |
| 7 | Dos órdenes impagas simultáneas | ⬜ | | |
| 8 | Ventana vencida | ⬜ | | |
