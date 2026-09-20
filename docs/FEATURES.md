# FEATURES — gesty-backend

Catálogo comercial/técnico de **este** backend: qué entrega o planea para el local de experimento y clientes SaaS.  
No sincroniza features de otros repos (admin, apps, etc.).

| Metadato | Valor |
|----------|--------|
| Repo | `gesty-backend` |
| Actualizado | 2026-09-20 |
| Rule | `.cursor/rules/features-catalog.mdc` |
| Planes | [`docs/planes-accion/`](./planes-accion/) |

---

## Cómo usar este archivo

Cada fila es una capacidad de **producto** (valor para el local o la plataforma), no un chore interno.

| Campo | Valores / significado |
|-------|------------------------|
| **ID** | Prefijo de dominio + número (`WA-03`). Ver [Prefijos](#prefijos-de-id). |
| **Feature** | Nombre corto orientado a oferta. |
| **Estado** | `propuesto` → `en desarrollo` → `parcial` → `disponible` |
| **Ofrecible** | `sí` (se puede vender/mostrar al local) · `interno` (ops/plataforma) · `no` |
| **Remunerable** | `sí` (upsell/plan pago) · `incluido` (en el plan base) · `n/d` |
| **Valor para el local** | Beneficio en una frase. |
| **Notas/plan** | Evidencia (paths) y/o link a `docs/planes-accion/…`. |

**Reglas:** no marcar `disponible` sin evidencia en código de este repo. Al pasar a `disponible`, registrar en [Historial](#historial-de-actualizaciones) y fijar `incluido` o `sí` en Remunerable.

### Prefijos de ID

| Prefijo | Dominio |
|---------|---------|
| `WA-` | WhatsApp, inbox, handoff, mensajes admin |
| `ORD-` | Pedidos, carrito, delivery assignment, menú operativo |
| `RES-` | Reservas, mesas, slots, check-in |
| `PAY-` | Pagos del pedido (MP, transferencia, comprobantes, métodos) |
| `BILL-` | Billing SaaS Stripe (suscripción del local a Gesty) |
| `AUTH-` | Auth, multi-tenant, roles, usuarios del negocio |
| `BE-` | Config del negocio, capabilities, bot kill-switch |
| `RT-` | Realtime Socket.IO admin |
| `BOT-` | Agente conversacional / LangGraph (superficie de producto) |

---

## WhatsApp / inbox

| ID | Feature | Estado | Ofrecible | Remunerable | Valor para el local | Notas/plan |
|----|---------|--------|-----------|-------------|---------------------|------------|
| WA-01 | Webhook WhatsApp → bot | disponible | sí | incluido | Canal de venta y atención 24/7 | `POST/GET /api/whatsapp/webhook`, `src/services/whatsapp.service.ts`, `src/graph/` |
| WA-02 | Listado conversaciones y mensajes (admin) | disponible | sí | incluido | Ver el historial del chat desde el panel | `GET /api/admin/whatsapp/conversations`, `…/messages` |
| WA-03 | Reply humano + bot por chat (`is_human_handled`) | disponible | sí | incluido | Equipo responde y pausa el bot en ese chat | `POST …/messages`, `GET/PATCH …/bot`; `humanHandover.service.ts` |
| WA-04 | Escalación a humano + socket support | disponible | sí | incluido | Cliente pide “hablar con alguien” y el panel se entera | Gate escalation + `whatsapp.support_requested` |
| WA-05 | Ownership: asignación de chat | disponible | sí | incluido | Saber quién atiende cada conversación | `PATCH …/assignment`, `POST …/take`; [PLAN-ACCION-INBOX-EQUIPO](./planes-accion/PLAN-ACCION-INBOX-EQUIPO.md) |
| WA-06 | Support ack durable | disponible | sí | incluido | Cola de soporte no se pierde al refrescar | `POST …/support-ack`; campos `support_*` en `conversation` |
| WA-07 | Autor tipado en mensajes admin | disponible | sí | incluido | Ver qué usuario del local envió cada reply | `sent_by_user_id` + `sentByUserId` / `sentByUserName` |
| WA-08 | Notas internas de conversación | disponible | sí | incluido | Instrucciones de equipo sin ir a Meta | CRUD `…/notes`; modelo `conversation_note` |
| WA-09 | Presence / viewers (anti-colisión liviana) | parcial | sí | incluido | Ver quién está mirando el chat | In-memory TTL 60s; límite multi-réplica; `POST …/viewing` + `whatsapp.viewers_updated` |
| WA-10 | Respuestas rápidas (canned) | disponible | sí | incluido | Responder más rápido con plantillas del local | CRUD `/whatsapp/canned-replies`; modelo `canned_reply` |
| WA-11 | Auto-timeout handoff → bot | disponible | sí | incluido | Si nadie atiende, el bot vuelve solo | Worker `humanHandoffTimeout`; flag `ENABLE_HANDOFF_TIMEOUT_WORKER`; `whatsapp.bot_auto_reactivated` |
| WA-12 | Sentiment AI por conversación | disponible | sí | incluido | Priorizar chats tensos | `ai_sentiment*`; canal `admin:conversation_sentiment` |
| WA-13 | HSM / Message Templates Meta (outbound) | propuesto | sí | sí | Avisos fuera de ventana 24h sin riesgo WABA | Ver pipeline; falta `sendTemplateMessage` |

SQL de columnas/tablas inbox: `prisma/sql/inbox_equipo_fase_a_c.sql` (aplicar en Postgres si el entorno aún no las tiene).

---

## Pedidos / menú / delivery

| ID | Feature | Estado | Ofrecible | Remunerable | Valor para el local | Notas/plan |
|----|---------|--------|-----------|-------------|---------------------|------------|
| ORD-01 | Pedido por WhatsApp (draft → order) | disponible | sí | incluido | Tomar pedidos sin app del cliente | Graph checkout/dispatch; `draft_order` / `orders` |
| ORD-02 | Admin pedidos (listado, status, payment-status) | disponible | sí | incluido | Operar cocina/mostrador desde el panel | `/api/admin/orders*` |
| ORD-03 | Asignación de repartidor | disponible | sí | incluido | Coordinar delivery del equipo | `PATCH …/delivery-assignment` |
| ORD-04 | Zonas de cobertura + fee | disponible | sí | incluido | Cobrar envío según zona | `business_coverage_zone`; admin delivery-zones |
| ORD-05 | Menú admin + imágenes | disponible | sí | incluido | Mantener carta viva | `/menu-items*`, categorías/opciones |
| ORD-06 | Promociones (admin + eval checkout) | disponible | sí | incluido | Ofertas configurables en el pedido | `adminPromotions*`, `services/promotions/*` |
| ORD-07 | Variaciones de plato | disponible | sí | incluido | Tamaños/variantes sin duplicar ítems | Schema + CRUD admin + picker bot |
| ORD-08 | Tracking en vivo del repartidor | propuesto | sí | sí | Cliente ve ETA/ubicación | Sin integración hoy |
| ORD-09 | ETA dinámico de entrega | propuesto | sí | sí | Expectativa de tiempo realista | Hoy solo `expires_at` de draft |
| ORD-10 | Storefront público por slug (`/shopping/[slug]`) | disponible | sí | incluido | Menú + pedido autoservicio (cobro en mostrador) | GET perfil/menú/hours/fulfillment; POST + GET orders cash unpaid (TAKE_AWAY + DELIVERY vía ORD-11). Menú unificado incluye ficha: `servesPeople`, `ingredients`, `ingredientsNotes`, `preparation`, `variations`. Canal: `storefront_enabled` (BE-15). [PLAN-ACCION-STOREFRONT-PUBLICO](./planes-accion/PLAN-ACCION-STOREFRONT-PUBLICO.md) |
| ORD-11 | Delivery en storefront (quote + pin) | disponible | sí | incluido | Pedir con envío desde la web, no solo retiro | `POST …/delivery-quote`; POST orders `DELIVERY` + address lat/lng; reusa zonas ORD-04; cash unpaid; `mapCenter` en fulfillment; `deliveryEnabled` = propio **o** externo. [PLAN-ACCION-STOREFRONT-DELIVERY](./planes-accion/PLAN-ACCION-STOREFRONT-DELIVERY.md) · [CONTEXTO-SHOPPING](./planes-accion/CONTEXTO-SHOPPING-STOREFRONT-DELIVERY.md) |
| ORD-12 | Reverse geocode storefront (pin → calle) | disponible | sí | incluido | Autocompletar calle al soltar el pin (sin reescribir a mano) | `POST …/reverse-geocode`; `geocoding.service` + cache; compartido con bot. [PLAN](./planes-accion/PLAN-ACCION-STOREFRONT-REVERSE-GEOCODE.md) · [CONTEXTO-SHOPPING](./planes-accion/CONTEXTO-SHOPPING-STOREFRONT-REVERSE-GEOCODE.md) |
| ORD-13 | Web Push seguimiento storefront | disponible | sí | incluido | Aviso del SO cuando el pedido avanza (aunque cierre el browser) | VAPID + subscription; título `{local} · {evento}`; body `Pedido #{ref} · …`; sin logo. TAKE_AWAY: `ready_for_pickup` (+ `shipped` legacy); DELIVERY: `shipped`; + `cancelled`. [PLAN](./planes-accion/PLAN-ACCION-STOREFRONT-WEB-PUSH.md) · [CONTEXTO-SHOPPING](./planes-accion/CONTEXTO-SHOPPING-STOREFRONT-WEB-PUSH.md) |

---

## Reservas

| ID | Feature | Estado | Ofrecible | Remunerable | Valor para el local | Notas/plan |
|----|---------|--------|-----------|-------------|---------------------|------------|
| RES-01 | Reserva por WhatsApp (wizard/agent) | disponible | sí | incluido | Reservar mesa conversando | Tipables §3.11; menú mid-reserva (delegate+anti-loop+FAQ híbrido sin CTA de pedido); bandas; gate ambiente. Planes Hecho 2026-09-16: MENU-OFFTOPIC, SLOT-BANDA, AMBIENTE-CATALOGO, FAQ-HIBRIDO |
| RES-02 | Admin lectura de reservas + setup (mesas/ambientes/horas/slots) | disponible | sí | incluido | Configurar capacidad y ver reservas | CRUD setup; `GET /reservations` (sin create/patch admin) |
| RES-03 | Check-in post-reserva (token) | disponible | sí | incluido | Pedido en mesa tras llegar | `/checkin/:token*` |
| RES-04 | Recordatorios automáticos pre-reserva | propuesto | sí | sí | Bajar no-shows | Sin cron T-2h / T-30min |

---

## Pagos del pedido

| ID | Feature | Estado | Ofrecible | Remunerable | Valor para el local | Notas/plan |
|----|---------|--------|-----------|-------------|---------------------|------------|
| PAY-01 | Métodos de pago del local | disponible | sí | incluido | Definir cash / online / transferencia | `payment_method_config`; admin APIs |
| PAY-02 | Mercado Pago (preference + webhook) | disponible | sí | incluido | Cobrar online en Latam | `payment_intent`; `POST /api/payments/mercado-pago/webhook` |
| PAY-03 | Comprobante de transferencia + review admin | disponible | sí | incluido | Validar transferencias sin salir del panel | `payment_proof`; sockets `order.payment_proof_*` |
| PAY-04 | Credenciales MP por negocio | disponible | sí | incluido | Cada local con su cuenta MP | `business_payment_provider` |
| PAY-05 | Factura/comprobante PDF al cliente | propuesto | sí | sí | Comprobante formal post-pago | No hay generación PDF |

---

## Billing SaaS (Gesty)

| ID | Feature | Estado | Ofrecible | Remunerable | Valor para el local | Notas/plan |
|----|---------|--------|-----------|-------------|---------------------|------------|
| BILL-01 | Suscripción Stripe (Checkout, Portal, webhook) | disponible | sí | sí | Pagar el plan de Gesty self-serve | `src/services/billing/*`; [PLAN-ACCION-STRIPE-BILLING](./planes-accion/PLAN-ACCION-STRIPE-BILLING.md) (Fase 6 = UI otro repo) |
| BILL-02 | Gate bot por suscripción/trial | disponible | interno | n/d | Sin plan vigente no opera el bot | `evaluateBusinessBillingAccess`, subscription gate en graph |
| BILL-03 | Cuota AI admin | disponible | sí | incluido | Ver consumo de tokens/costo | `GET /api/admin/ai-quota` |
| BILL-04 | Super-admin billing (trial, sync, cancel) | disponible | interno | n/d | Ops de plataforma | `/api/super-admin` billing |
| BILL-05 | Planes públicos | disponible | sí | n/d | Landing / pricing | `GET /api/public/billing/plans` |
| BILL-06 | Plan solo web (sin IA/bot) | propuesto | sí | sí | SKU barato solo storefront; upgrade para bot | Entitlements `plan.features.channels`. [PLAN-ACCION-STOREFRONT-CANAL](./planes-accion/PLAN-ACCION-STOREFRONT-CANAL.md) Fase B |

---

## Auth / multi-tenant / capabilities

| ID | Feature | Estado | Ofrecible | Remunerable | Valor para el local | Notas/plan |
|----|---------|--------|-----------|-------------|---------------------|------------|
| AUTH-01 | Login JWT + refresh/logout | disponible | sí | incluido | Acceso seguro al panel | `auth.routes`, middleware JWT |
| AUTH-02 | Multi-tenant por `businessId` + roles | disponible | sí | incluido | Varios locales / roles OWNER…DELIVERY | `business_user`, `requireRoles` |
| AUTH-03 | CRUD usuarios del negocio | disponible | sí | incluido | Invitar equipo del local | `/business-users*` |
| AUTH-04 | Super-admin create business | disponible | interno | n/d | Onboarding de locales | `superAdmin.routes` |
| BE-01 | Capabilities bootstrap (defaults off + validación) | disponible | sí | incluido | Local nuevo no “parece listo” para vender | [PLAN-ACCION-CAPABILITIES-BOOTSTRAP](./planes-accion/PLAN-ACCION-CAPABILITIES-BOOTSTRAP.md) |
| BE-02 | Gates bot por capacidades (pedidos/reservas) | disponible | sí | incluido | El bot no vende lo que el local no habilitó | `capabilityAccessGate`, `ordersCapabilityGate` |
| BE-03 | Kill-switch `bot_enabled` | disponible | sí | incluido | Apagar el canal WhatsApp del local | `business_config.bot_enabled` |
| BE-15 | Canal storefront (`storefront_enabled`) | disponible | sí | incluido | Prender/apagar menú+pedidos web sin bot | Un flag = vitrina+orders. Gate en `resolveActivePublicBusiness`. [PLAN-ACCION-STOREFRONT-CANAL](./planes-accion/PLAN-ACCION-STOREFRONT-CANAL.md) · [CONTEXTO-ADMIN](./planes-accion/CONTEXTO-ADMIN-STOREFRONT-CANAL.md) |

Handoff UI de checklist (otro repo): [PLAN-ACCION-ADMIN-CAPABILITIES-SETUP](./planes-accion/PLAN-ACCION-ADMIN-CAPABILITIES-SETUP.md) — **no** es feature de este backend.

---

## Realtime

| ID | Feature | Estado | Ofrecible | Remunerable | Valor para el local | Notas/plan |
|----|---------|--------|-----------|-------------|---------------------|------------|
| RT-01 | Socket.IO panel admin (salas por negocio) | disponible | sí | incluido | Panel en vivo sin polling | `src/socket/adminSocket.ts`; sala `admin:<businessId>` |
| RT-02 | Canal pedidos | disponible | sí | incluido | Cocina/caja al día | `admin:order` (`order.created`, status, payment_proof_*) |
| RT-03 | Canal reservas | disponible | sí | incluido | Sala alerta nuevas reservas | `admin:reservation` |
| RT-04 | Canal WhatsApp inbox | disponible | sí | incluido | Inbox colaborativo en vivo | `admin:whatsapp` (message, support, assignment, notes, viewers, bot_auto_reactivated) |

---

## Bot / agente (superficie de producto)

| ID | Feature | Estado | Ofrecible | Remunerable | Valor para el local | Notas/plan |
|----|---------|--------|-----------|-------------|---------------------|------------|
| BOT-01 | Agente LangGraph (pedidos + reservas + soporte) | disponible | sí | incluido | Atención automática acotada al negocio | `src/graph/mainGraph.ts` |
| BOT-02 | Owner assistant (dueño por WA) | disponible | sí | incluido | Dueño opera por el mismo número | `ownerAssistant`; `owner_whatsapp_phones` |
| BOT-03 | Audio del dueño → STT | disponible | sí | incluido | Dueño manda notas de voz | `normalizeOwnerAudio`, speech-to-text |
| BOT-04 | Personalidad del bot | disponible | sí | incluido | Tono de marca del local | `bot_personality` + humanize |
| BOT-05 | Audio del cliente → pedido | propuesto | sí | sí | Pedir por nota de voz | Cliente: audio aún no entra al flujo de pedido |
| BOT-06 | Catálogo nativo WhatsApp (product list) | propuesto | sí | sí | UX más rica que listas/botones | No implementado |

---

## Otras capacidades de plataforma

| ID | Feature | Estado | Ofrecible | Remunerable | Valor para el local | Notas/plan |
|----|---------|--------|-----------|-------------|---------------------|------------|
| BE-10 | Anuncios plataforma → admin | disponible | interno | n/d | Comunicar novedades a locales | `announcement*`; super-admin + admin |
| BE-11 | Menú / planes públicos (vitrina) | disponible | sí | n/d | Landing / deep links | `/api/public/...` (featured/item por UUID; storefront slug → ORD-10) |
| BE-12 | Dashboard + analytics admin | disponible | sí | incluido | Resumen operativo | `/dashboard/summary`, `/analytics/*` |
| BE-13 | Loyalty / puntos / campañas broadcast | propuesto | sí | sí | Fidelizar y reactivar | Sin modelos campaign/loyalty |
| BE-14 | Acceso STAFF al inbox | propuesto | sí | incluido | Mozos en chat (hoy solo OWNER/ADMIN) | Fuera de alcance inbox A–C |

---

## Pipeline / no disponible

Ítems `propuesto` priorizados (sin compromiso de sprint):

1. **WA-13** — HSM / templates Meta (riesgo ventana 24h + Meta 2026).
2. **BOT-05** — Audio cliente → pedido.
3. **RES-04** — Recordatorios pre-reserva.
4. **ORD-08 / ORD-09** — Tracking / ETA delivery.
5. **BE-13** — Loyalty / campañas.
6. **WA-09** — Viewers multi-réplica (Redis) para cerrar el `parcial`.

Inventario legado de gaps (parcialmente desactualizado vs código actual): [`PENDING-FEATURES.md`](../PENDING-FEATURES.md) en la raíz — usar este catálogo como fuente de verdad de estados.

---

## Plantilla de fila nueva

```markdown
| XX-00 | Nombre corto | propuesto | sí | incluido | Beneficio en una frase | Link a plan o paths |
```

---

## Historial de actualizaciones

| Fecha | Cambio |
|-------|--------|
| 2026-09-20 | ORD-10: menú público (`GET …/menu` e items) serializa ficha de ítem (`servesPeople`, `ingredients`, `ingredientsNotes`, `preparation`, `variations`) para sheet de detalle en vitrina. |
| 2026-09-20 | ORD-13: push personalizado — `{businessName} · evento` + `Pedido #{orderRef}` en body (sin icon/logo). |
| 2026-09-20 | ORD-13: TAKE_AWAY también notifica en `shipped` (valor que escribe el admin); copy “Listo para retirar”. `ready_for_pickup` sigue como legacy. |
| 2026-09-20 | ORD-13 → `disponible`: Web Push storefront (VAPID, subscription por orderId, envío best-effort en cambio de status). Front pendiente staging. |
| 2026-09-20 | ORD-11: storefront trata `external_delivery_enabled` como envío (mismo OR que el bot). |
| 2026-09-20 | ORD-12 → `disponible`: reverse geocode público + cache; bot usa el mismo servicio. |
| 2026-09-20 | ORD-11 → `disponible`: quote + POST DELIVERY (pin lat/lng), snapshot address, `mapCenter` en fulfillment. |
| 2026-09-20 | ORD-11 propuesto: delivery storefront (quote + mapa/pin; cash unpaid; sin geocode mock). |
| 2026-09-20 | BE-15 → `disponible`: `storefront_enabled` + gates API pública (Fase A). BILL-06 sigue propuesto (Fase B SKU). |
| 2026-09-20 | BE-15 + BILL-06 propuestos: canal `storefront_enabled` + plan Stripe solo web (upgrade para IA). Plan + contexto admin. |
| 2026-09-20 | ORD-10 Fase E: `GET …/orders/:orderId` seguimiento storefront (misma forma que POST 201). |
| 2026-09-20 | ORD-10 storefront público por slug → `disponible` (GET + POST orders cash/mostrador, aislado de MP/WA). |
| 2026-09-20 | ORD-10 storefront público por slug → `parcial` (GET perfil/menú/hours/fulfillment/payment-methods; sin POST orders). |
| 2026-09-06 | Creación del catálogo. Inbox equipo A–C → `disponible` (WA-05…WA-11; viewers `parcial`). Stripe billing backend → `disponible` (BILL-*). Capabilities bootstrap → `disponible` (BE-01/02). |
