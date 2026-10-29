# FEATURES — gesty-backend

Catálogo comercial/técnico de **este** backend: qué entrega o planea para el local de experimento y clientes SaaS.  
No sincroniza features de otros repos (admin, apps, etc.).

| Metadato | Valor |
|----------|--------|
| Repo | `gesty-backend` |
| Actualizado | 2026-09-22 |
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
| ORD-10 | Storefront público por slug (`/shopping/[slug]`) | disponible | sí | incluido | Menú + pedido autoservicio (cobro en mostrador) | GET perfil/menú/hours/fulfillment; POST + GET orders (cash y/o online vía PAY-06). Menú unificado incluye ficha: `servesPeople`, `ingredients`, `ingredientsNotes`, `preparation`, `variations`. Canal: `storefront_enabled` (BE-15). [PLAN-ACCION-STOREFRONT-PUBLICO](./planes-accion/PLAN-ACCION-STOREFRONT-PUBLICO.md) |
| ORD-11 | Delivery en storefront (quote + pin) | disponible | sí | incluido | Pedir con envío desde la web, no solo retiro | `POST …/delivery-quote`; POST orders `DELIVERY` + address lat/lng; reusa zonas ORD-04; cash unpaid; `mapCenter` en fulfillment; `deliveryEnabled` = propio **o** externo. [PLAN-ACCION-STOREFRONT-DELIVERY](./planes-accion/PLAN-ACCION-STOREFRONT-DELIVERY.md) · [CONTEXTO-SHOPPING](./planes-accion/CONTEXTO-SHOPPING-STOREFRONT-DELIVERY.md) |
| ORD-12 | Reverse geocode storefront (pin → calle) | disponible | sí | incluido | Autocompletar calle al soltar el pin (sin reescribir a mano) | `POST …/reverse-geocode`; `geocoding.service` + cache; compartido con bot. [PLAN](./planes-accion/PLAN-ACCION-STOREFRONT-REVERSE-GEOCODE.md) · [CONTEXTO-SHOPPING](./planes-accion/CONTEXTO-SHOPPING-STOREFRONT-REVERSE-GEOCODE.md) |
| ORD-13 | Web Push seguimiento storefront | disponible | sí | incluido | Aviso del SO cuando el pedido avanza (aunque cierre el browser) | Push en `preparing`, listo/`shipped`, `delivered`, `cancelled`. Título `{local} · …`; body `Pedido #{ref}`. Sin logo. [PLAN](./planes-accion/PLAN-ACCION-STOREFRONT-WEB-PUSH.md) · [CONTEXTO-SHOPPING](./planes-accion/CONTEXTO-SHOPPING-STOREFRONT-WEB-PUSH.md) |

---

## Reservas

| ID | Feature | Estado | Ofrecible | Remunerable | Valor para el local | Notas/plan |
|----|---------|--------|-----------|-------------|---------------------|------------|
| RES-01 | Reserva por WhatsApp (wizard/agent) | disponible | sí | incluido | Reservar mesa conversando | Tipables §3.11; menú mid-reserva; bandas; gate ambiente; híbrido→reserva con carrito pide cancelar pedido (§3.11). Planes Hecho 2026-09-16: MENU-OFFTOPIC, SLOT-BANDA, AMBIENTE-CATALOGO, FAQ-HIBRIDO |
| RES-02 | Admin lectura de reservas + setup (mesas/ambientes/horas/slots) | disponible | sí | incluido | Configurar capacidad y ver reservas | CRUD setup; `GET /reservations` (sin create/patch admin) |
| RES-03 | Check-in post-reserva (token) | disponible | sí | incluido | Pedido en mesa tras llegar | `/checkin/:token*` |
| RES-04 | Recordatorios automáticos pre-reserva | propuesto | sí | sí | Bajar no-shows | Sin cron T-2h / T-30min |
| RES-05 | Menú en marco reserva: handoff + sugerencia por raciones | en desarrollo | sí | incluido | “Qué platos para la mesa” arma draft y sugiere por `serves_people` | Sin flag admin. Personas antes que fecha en draft. [PLAN](./planes-accion/PLAN-ACCION-RESERVA-MENU-PORCIONES-HANDOFF.md) |

---

## Pagos del pedido

| ID | Feature | Estado | Ofrecible | Remunerable | Valor para el local | Notas/plan |
|----|---------|--------|-----------|-------------|---------------------|------------|
| PAY-01 | Métodos de pago del local | disponible | sí | incluido | Definir cash / online / transferencia | `payment_method_config`; admin APIs |
| PAY-02 | Mercado Pago (preference + webhook) | disponible | sí | incluido | Cobrar online en Latam | `payment_intent`; `POST /api/payments/mercado-pago/webhook`. Firma HMAC no corta: se confirma el cobro con GET payment + intent pending. |
| PAY-03 | Comprobante de transferencia + review admin | disponible | sí | incluido | Validar transferencias sin salir del panel | `payment_proof`; sockets `order.payment_proof_*` |
| PAY-04 | Credenciales MP por negocio | disponible | sí | incluido | Cada local con su cuenta MP | `business_payment_provider` |
| PAY-05 | Factura/comprobante PDF al cliente | propuesto | sí | sí | Comprobante formal post-pago | No hay generación PDF |
| PAY-06 | Pago online storefront (MP Checkout Pro) | disponible | sí | incluido | Cobrar con MP desde la vitrina web | Orden unpaid → preference → webhook paid; `back_urls` por orden a `/shopping/{slug}/orders/{orderId}?payment=…` (`STOREFRONT_PUBLIC_ORIGIN`). [PLAN](./planes-accion/PLAN-ACCION-STOREFRONT-MP-ONLINE.md) · [CONTEXTO-SHOPPING](./planes-accion/CONTEXTO-SHOPPING-STOREFRONT-MP-ONLINE.md) |
| PAY-07 | Páginas back_url pago bot (MP) | disponible | sí | incluido | Tras pagar en MP, el cliente ve estado + CTA al chat WA | `GET /payment/success\|failure\|pending`; defaults con `business_id`; HTML minimalista. [PLAN](./planes-accion/PLAN-ACCION-PAYMENT-RETURN-PAGES.md) |

---

## Billing SaaS (Gesty)

| ID | Feature | Estado | Ofrecible | Remunerable | Valor para el local | Notas/plan |
|----|---------|--------|-----------|-------------|---------------------|------------|
| BILL-01 | Suscripción Stripe (Checkout, Portal, webhook) | disponible | sí | sí | Pagar el plan de Gesty self-serve | `src/services/billing/*`; [PLAN-ACCION-STRIPE-BILLING](./planes-accion/PLAN-ACCION-STRIPE-BILLING.md) (Fase 6 = UI otro repo) |
| BILL-02 | Gate bot por suscripción/trial | disponible | interno | n/d | Sin plan vigente no opera el bot | `evaluateBusinessBillingAccess`, subscription gate en graph |
| BILL-03 | Cuota AI admin | disponible | sí | incluido | Ver consumo de tokens/costo | `GET /api/admin/ai-quota` |
| BILL-04 | Super-admin billing (trial, sync, cancel) | disponible | interno | n/d | Ops de plataforma | `/api/super-admin` billing |
| BILL-05 | Planes públicos | disponible | sí | n/d | Landing / pricing | `GET /api/public/billing/plans` |
| BILL-06 | Plan solo web (sin IA/bot) | cancelado | no | n/d | — | Decisión 2026-09-20: vitrina **incluida** en todos los planes; kill switch `storefront_enabled` (BE-15). Sin SKU ni `plan.features.channels`. |

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
| BE-15 | Canal storefront (`storefront_enabled`) | disponible | sí | incluido | Prender/apagar menú+pedidos web sin bot | Incluido en todos los planes (default `true`); admin kill switch. Gate en `resolveActivePublicBusiness`. Sin SKU aparte. [PLAN-ACCION-STOREFRONT-CANAL](./planes-accion/PLAN-ACCION-STOREFRONT-CANAL.md) · [CONTEXTO-ADMIN](./planes-accion/CONTEXTO-ADMIN-STOREFRONT-CANAL.md) |

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
| BOT-01 | Agente LangGraph (pedidos + reservas + soporte) | disponible | sí | incluido | Atención automática acotada al negocio | `src/graph/mainGraph.ts`; welcome `ORDER_FOOD` → híbrido/party size; si el gate de personas frena búsqueda/filtro/cola/alta, deja el pedido en espera; `save_party_size` guarda el número y no borra esa intención (sale al pasar a cola/carrito, al cancelar o al reemplazarla un lookup de otro turno, [ADR-0014](adr/0014-intencion-pendiente-sobrevive-al-gate.md)); cancel tipable + guard; cancel de dominio aunque el turno lo tenga el otro agente; lienzo `{}` si no queda dueño; ola complemento multi-candidato → `plan_order_lines`; búsqueda count 0 cierra la línea de cola coincidente; ≥2 nombres que coinciden con el keyword arman lista y no se alta; [PLAN-ACCION-WELCOME-PEDIDO-Y-CANCEL-TIPABLE.md](planes-accion/PLAN-ACCION-WELCOME-PEDIDO-Y-CANCEL-TIPABLE.md) |
| BOT-02 | Owner assistant (dueño por WA) | disponible | sí | incluido | Dueño opera por el mismo número | `ownerAssistant`; `owner_whatsapp_phones` |
| BOT-03 | Audio del dueño → STT | disponible | sí | incluido | Dueño manda notas de voz | `normalizeOwnerAudio`, speech-to-text |
| BOT-04 | Personalidad del bot | disponible | sí | incluido | Tono de marca del local | `bot_personality` + humanize |
| BOT-05 | Audio del cliente → pedido | propuesto | sí | sí | Pedir por nota de voz | Cliente: audio aún no entra al flujo de pedido |
| BOT-06 | Catálogo nativo WhatsApp (product list) | propuesto | sí | sí | UX más rica que listas/botones | No implementado |
| BOT-07 | Estado de dominio en turno frío (mapa sesiones + capacidades) | en desarrollo | interno | incluido | El bot deja de asumir “pedido” ante consultas de reserva | Ledger de turno frío declara sesiones + caminos del local. Espejo food-service-agent: runtime + tests fases 1–14. [PLAN](./planes-accion/PLAN-ACCION-ESTADO-DOMINIO-TURNO-FRIO.md) |

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
| 2026-09-27 | BOT-01: en el alta, un `quantity` del modelo no cuenta como unidades si el mensaje habla de personas ("para dos", "somos dos"). Con ración que ya cubre la mesa se escribe `ceil(personas / ración)`; "dos ceviches" sigue siendo 2. |
| 2026-09-27 | BOT-01: con cantidad pendiente, `add_cart_item` solo escribe el producto de ese pending. Un alta de otro plato en el mismo turno no toca el carrito ni borra el pending. El cierre nombra el producto que sí se agregó. |
| 2026-09-27 | BOT-01: `save_party_size` ya no borra el pedido en espera. Esa intención se va solo cuando pasa a la cola o al carrito, al cancelar, o cuando una búsqueda de otro turno la reemplaza. [ADR-0014](./adr/0014-intencion-pendiente-sobrevive-al-gate.md) |
| 2026-09-27 | BOT-01: `search_products` count 0 cancela la línea de cola cuyo hint cubre el keyword (no un recorte) y el aviso de “no lo tenemos” es una sola vez. |
| 2026-09-23 | PAY-02: webhook MP no descarta el cobro si falla el HMAC; confirma con GET payment + intent pending. |
| 2026-09-22 | BOT-07: espejo food-service-agent de fases 1–14 (runtime ya estaba; se portó la red de tests + e2e `faq-platos-cierre-unico`). [PLAN](./planes-accion/PLAN-ACCION-ESTADO-DOMINIO-TURNO-FRIO.md) |
| 2026-09-22 | RES-01: los horarios se muestran solo si la fecha ya está guardada en el borrador — `get_available_slots` devuelve `date_required` / `date_mismatch` y la lista sale con la fecha del borrador, no con la que dedujo el modelo. Evita que el bot liste horarios de una fecha que el cliente nunca confirmó. |
| 2026-09-22 | RES-05: la respuesta de menú durante una reserva cierra una sola vez. El texto del bot termina en el dato del menú y la única pregunta es la que anexa el sistema (“¿Seguimos con la reserva o preferís cancelarla?”): se fue el cierre propio del modelo (“¿Te gustaría seguir con la reserva o hay algo más que necesites?”) y la frase de unidades del mundo pedido (“para 6 podés llevar más de una unidad”), que no aplica porque la reserva guarda la mesa, no platos. Si el modelo igual escribe esa pregunta final, el sistema ya no la anexa dos veces. E2E `faq-platos-cierre-unico`. [PLAN](./planes-accion/PLAN-ACCION-ESTADO-DOMINIO-TURNO-FRIO.md) |
| 2026-09-22 | RES-05: `suggest_dishes_for_party_size` busca los candidatos por cercanía a la cantidad de personas (antes tomaba las 80 raciones más chicas del menú, así que los platos para 6 nunca entraban y siempre respondía con porciones individuales) y deja afuera bebidas y postres cuando el cliente no nombró nada puntual. Si preguntó por un plato (“y tienen pollo?”) la respuesta se filtra por esa palabra, y el bot ya no ofrece “agregar alguno a la reserva” (la reserva guarda la mesa, no platos). [PLAN](./planes-accion/PLAN-ACCION-ESTADO-DOMINIO-TURNO-FRIO.md) |
| 2026-09-22 | BOT-07 / RES-05: en turno de reserva, `search_products` / `find_products_by_filter` responden el dato del menú pero no escriben `pendingProductSelection` ni ordenan la lista de selección de pedido. Antes ese pending sobrevivía turnos y terminaba sumando un plato al carrito en medio de una reserva. [PLAN](./planes-accion/PLAN-ACCION-ESTADO-DOMINIO-TURNO-FRIO.md) |
| 2026-09-21 | BOT-07 / RES-05: abrir la mesa cierra el dominio pedido — adopta las personas del pedido en `reservation_draft` y hace wipe de shortlist/pendings/CTA/Ledger (antes solo pasaba al cancelar carrito). Si el bot elige la puerta equivocada, el cliente lo corrige en un mensaje sin repetir el número. [PLAN](./planes-accion/PLAN-ACCION-ESTADO-DOMINIO-TURNO-FRIO.md) |
| 2026-09-21 | RES-05: post-FAQ de menú solo “¿seguimos o cancelás?”; fecha y horarios no se piden en ese turno. [PLAN](./planes-accion/PLAN-ACCION-ESTADO-DOMINIO-TURNO-FRIO.md) |
| 2026-09-21 | RES-05: FAQ de platos lista como pedido (`• *Nombre*` / `ración para: N`); la cuenta cover no va al cliente. [PLAN](./planes-accion/PLAN-ACCION-ESTADO-DOMINIO-TURNO-FRIO.md) |
| 2026-09-21 | RES-05 / BOT-07: `suggest_dishes` sin ración exacta sugiere platos más chicos × `ceil(N/serves)` (cover); no hay segundo LLM. [PLAN](./planes-accion/PLAN-ACCION-ESTADO-DOMINIO-TURNO-FRIO.md) |
| 2026-09-21 | RES-05 / BOT-07: Fact `pendingReservationDishFaq` al bloquear FAQ sin N; con personas el nodo delega al híbrido (consulta original) antes de pedir fecha. [PLAN](./planes-accion/PLAN-ACCION-ESTADO-DOMINIO-TURNO-FRIO.md) |
| 2026-09-21 | RES-05 / BOT-07: FAQ de platos para la mesa no corre sin `reservation_draft.partySize` (el reason “para 1” no es Fact); `suggest_dishes` sin N → `reservation_party_size_required`. [PLAN](./planes-accion/PLAN-ACCION-ESTADO-DOMINIO-TURNO-FRIO.md) |
| 2026-09-21 | BOT-01: “Cancelar pedido” / “Cancelar reserva” ejecutan el wipe de ese dominio aunque el turno lo tenga el otro agente; si no queda dueño, metadata `{}` (lienzo). El corte de historial queda pendiente. |
| 2026-09-21 | BOT-07 en desarrollo en gesty-backend: mapa de sesiones + capacidades en turno frío. El espejo en food-service-agent queda para después de validar conversaciones acá. |
| 2026-09-21 | BOT-07 propuesto: turno frío declara sesiones abiertas + capacidades del local; hoy el bloque arranca inclinado a pedido. [PLAN-ACCION-ESTADO-DOMINIO-TURNO-FRIO](./planes-accion/PLAN-ACCION-ESTADO-DOMINIO-TURNO-FRIO.md) |
| 2026-09-21 | RES-05: al abrir sesión de reserva se limpian `requestedPartySize`/`peopleCount` — el híbrido a veces llama `save_party_size` en el mismo turno que delega y el Fact reaparecía como “Personas para el pedido”. |
| 2026-09-21 | RES-05 fix loop: `suggest_dishes_for_party_size` sin sesión de reserva devuelve `reservation_session_required` y empuja `start_reservation_session` — antes caía en el gate de pedido y repetía “¿Para cuántas personas?”. |
| 2026-09-21 | RES-05 opción 1: party size de pedido se apaga por Facts de dominio reserva (`reservation_agent_active` / FAQ / pending switch), sin diccionario de prosa. |
| 2026-09-21 | RES-05: revert gate regex `isReservationFramedMenuMessage` (falsos positivos menú/carta); handoff sigue por prompt/tool. |
| 2026-09-21 | RES-05: menú enmarcado en reserva no abre Goal party size de pedido; ledger empuja `start_reservation_session` (handoff blando). |
| 2026-09-21 | RES-05 en desarrollo: handoff menú→reservas; draft personas→fecha; `suggest_dishes_for_party_size` en FAQ mid-reserva. |
| 2026-09-21 | RES-05 propuesto: handoff main↔reservas ante menú “para reservas” + sugerencia por `serves_people` (sin flag admin). [PLAN-ACCION-RESERVA-MENU-PORCIONES-HANDOFF](./planes-accion/PLAN-ACCION-RESERVA-MENU-PORCIONES-HANDOFF.md) |
| 2026-09-21 | BOT-01: welcome atajo "Hacer un pedido" (`ORDER_FOOD` → híbrido); cancel tipable Carrito/Pedido + guard si el modelo no llama `cancel_order`. |
| 2026-09-21 | BOT-01: soft-gate ola de complemento — `add_cart_item` solo si el mensaje nombra un candidato; rechazo blando → `mark_complement_refused` (sin inventar add). |
| 2026-09-21 | BOT-01: `welcomeEligible` tras cancel pedido/reserva — saludo vuelve a ofrecer welcome (no party size); force soft en híbrido. |
| 2026-09-21 | RES-01: al confirmar cancelar pedido→reserva, entrada fresca al agente (sin payload «Sí, cancelar» que disparaba abandon). |
| 2026-09-21 | BOT-01: cantidad dicha en el mensaje ("dame dos…") confirma el add; runtime no tapa quantity_required con present_cart/complemento. |
| 2026-09-21 | BOT-01: tras complemento/shortlist, elegir candidato ("dame dos ají…") gana sobre tipable VIEW_CART/present_cart (ledger + prompt). |
| 2026-09-21 | RES-01 / BOT-01: híbrido→reserva con carrito activo pide confirmar cancelar pedido; al confirmar wipe draft + abre reservas (botón + tipable §3.11). |
| 2026-09-21 | BOT-01: shortlist ≥2 bloquea add en el mismo turno; no CTA tras add exitoso. |
| 2026-09-21 | BOT-01: cancelar pedido en checkout hace wipe completo (sesión + carrito), no deja pago/carrito vivos. |
| 2026-09-21 | BOT-01: party size siempre antes de shortlist/add (gate en tools de catálogo + Goal; sin bypass por cantidad de línea). |
| 2026-09-20 | PAY-07 → `disponible`: páginas HTML back_url bot MP (`/payment/success\|failure\|pending`) + CTA wa.me. |
| 2026-09-20 | ORD-10: menú público (`GET …/menu` e items) serializa ficha de ítem (`servesPeople`, `ingredients`, `ingredientsNotes`, `preparation`, `variations`) para sheet de detalle en vitrina. |
| 2026-09-20 | ORD-13: notificar también `preparing` y `delivered` (además de listo/en camino/cancelado). |
| 2026-09-21 | BOT-01: ola de complemento con ≥2 candidatos en un mensaje → `plan_order_lines` (cierra ola; cola antes de nueva opportunity). |
| 2026-09-20 | ORD-13: push personalizado — `{businessName} · evento` + `Pedido #{orderRef}` en body (sin icon/logo). |
| 2026-09-20 | ORD-13: TAKE_AWAY también notifica en `shipped` (valor que escribe el admin); copy “Listo para retirar”. `ready_for_pickup` sigue como legacy. |
| 2026-09-20 | ORD-13 → `disponible`: Web Push storefront (VAPID, subscription por orderId, envío best-effort en cambio de status). Front pendiente staging. |
| 2026-09-20 | PAY-06: con `STOREFRONT_PUBLIC_ORIGIN` no reusar init_point viejo (preferences sin back_urls); warn si falta el env. |
| 2026-09-20 | PAY-06: `back_urls` dinámicas por slug/orderId (`/shopping/…/orders/…?payment=`); sin origin se omiten (no `/payment/success`). |
| 2026-09-20 | PAY-06 → `disponible`: MP Checkout Pro en storefront (quote methods + POST online + webhook order-first). |
| 2026-09-20 | BILL-06 cancelado: vitrina en todos los planes; default `storefront_enabled=true` (opt-out admin). BE-15 docs alineados. |
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
