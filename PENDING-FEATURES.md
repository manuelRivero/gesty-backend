# Funcionalidades pendientes y estado del producto

> **Propósito del documento:** inventario de brechas, cumplimiento regulatorio (Meta 2026) y roadmap. Sirve como **lectura ejecutiva** y como **contexto estructurado** para agentes de código (búsqueda por sección, tablas y estados normalizados).

| Metadato | Valor |
|----------|--------|
| Ámbito | WhatsApp Business, pedidos, reservas, pagos, operación |
| Estados usados | Cumplido · Parcial · No / faltante · No implementado |
| Repos implicados | `food-service-agent` y backend relacionado |

---

## Índice

1. [Contexto regulatorio (Meta / WhatsApp 2026)](#1-contexto-regulatorio-meta--whatsapp-2026)
2. [Capacidades core del producto](#2-capacidades-core-del-producto)
3. [Resumen ejecutivo](#3-resumen-ejecutivo)
4. [Riesgos técnicos heredados](#4-riesgos-técnicos-heredados)
5. [Próximo trimestre sugerido](#5-próximo-trimestre-sugerido)

---

## 1. Contexto regulatorio (Meta / WhatsApp 2026)

### 1.1 Regla crítica

Desde el **15 de enero de 2026**, Meta prohíbe explícitamente los chatbots de **propósito general** en la WhatsApp Business Platform. Toda IA debe estar acotada a un **workflow del negocio** (pedidos, reservas, soporte, estado de pedido). Las consecuencias son fuertes: **suspensión del WABA** si el bot responde “como ChatGPT abierto”.

### 1.2 Cumplimiento frente a Meta

| Requisito Meta 2026 | Estado | Detalle técnico / producto |
|---------------------|--------|----------------------------|
| IA contextualizada al negocio (no general purpose) | **Cumplido** | `detectIntentWithConfidence` clasifica a un set cerrado de intents (`ConversationIntent`); `generateProductAwareResponse` recibe contexto del menú |
| Mecanismo de fallback / handoff humano | **Parcial** | Existe `is_human_handled` en `conversation_state`; falta UI de inbox/SLA y notificación al staff |
| Plantillas aprobadas para outbound proactivo | **No cumplido** | Sin infra de HSM/template; todo mensaje libre dentro de ventana 24 h (riesgo en notificaciones de estado fuera de ventana) |
| Sin respuestas open-ended | **Cumplido** (con matices) | Modo deterministic OK; con `AGENT_MODE=hybrid` hay system prompt restrictivo — conviene reforzarlo y documentarlo |

### 1.3 Acción urgente (regulatorio / operativo)

- Introducir **Message Templates (HSM)** para `notifyCustomerOrderStatusFromAdmin` y recordatorios de carrito.
- Hoy `WhatsAppSenderService` expone `sendTextMessage`, `sendListMessage`, `sendButtonMessage`, `sendImageFromDataUrl` — **falta** `sendTemplateMessage`.

---

## 2. Capacidades core del producto

### 2.1 Toma de pedidos y menú

| Feature mercado | Estado | Notas |
|-----------------|--------|--------|
| Captura por NLP en lenguaje natural | Cumplido | `detection.service.ts`, gpt-4o-mini, JSON output, set fijo de intents |
| Navegación por categorías + listas interactivas | Cumplido | `MenuService.getCategoryListForCustomer`, `getItemsByCategory`, builders en `whatsappBuilders/*` |
| Búsqueda fuzzy por nombre/ingrediente | Cumplido | `searchMenuItemsByKeyword` + `text-embedding-3-small` |
| Modificadores y alérgenos | Parcial / faltante | Schema con `menu_item.ingredients: String?` libre; sin modelo estructurado de modifiers/allergens ni flujo de selección |
| Items con porciones / “para cuántas personas” | Cumplido | `serves_people` + `peopleCountGate.service` |
| Recomendaciones / upsell automático | Parcial | `complementSuggestions.service`, `productQuery` / `smartFoodRecommendations` por reglas, no por historial del cliente |
| Cross-sell post-checkout (“¿agregás bebida?”) | Parcial | `showComplementSuggestionsHandler` existe pero manual; sin trigger automático tras add-to-cart |

### 2.2 Pagos

| Feature mercado | Estado | Notas |
|-----------------|--------|--------|
| Integración pasarela (MercadoPago / Stripe / WhatsApp Pay) | No implementado | `OrderPaymentStatus` solo `unpaid` / `paid`; toggle manual desde admin; sin link de pago ni webhook de pasarela |
| Confirmación de pago en chat | No | Flujo termina con orden `unpaid`; no se cierra ciclo de pago |
| Comprobantes / facturas digitales | No | Sin generación PDF/comprobante |

**Gap principal Latam (Argentina):** MercadoPago como estándar. Diseño mínimo sugerido:

1. Tabla `payment_intent` (`provider`, `external_id`, `amount`, `status`, `link`).
2. Handler `processPaymentLinkHandler` que genera y envía link tras checkout.
3. Webhook `/api/payments/:provider/webhook` que actualiza `orders.payment_status` y notifica al cliente.

### 2.3 Reservas

| Feature mercado | Estado |
|-----------------|--------|
| Wizard conversacional de reserva | Cumplido — `reservation.service.ts`, tablas `reservation`, `reservation_table`, `reservation_slot`, `reservation_block`, `reservation_config` |
| QR / confirmación | Cumplido — `viewQrHandler`, `utils/qrReservation*` |
| Recordatorios automáticos pre-reserva | Faltante — sin cron T-2h / T-30min |
| Cancelación / reprogramación por el cliente | Parcial — existe `cancelOrderHandler`; equivalente claro para reservas no está claro en `handlers/index.ts` |

### 2.4 Delivery y direcciones

| Feature mercado | Estado |
|-----------------|--------|
| Captura de dirección + geocoding | Cumplido — `address.service`, `geocoding_cache`, `customer_address` |
| Zonas de cobertura con fee | Cumplido — `business_coverage_zone`, `coverageZone` opcional en `EnrichedContext` |
| Tracking en vivo del repartidor | No — sin integración con app de repartidores ni ubicación en vivo |
| Estimación de tiempo (ETA dinámico) | No — solo `expires_at` del draft order |

### 2.5 Multimedia y multimodal

| Feature mercado | Estado |
|-----------------|--------|
| Recibir audio (transcripción → orden) | No — orquestador solo `text` e `interactive`; audio cae a `[unknown]` (`orchestrator.ts` ~434) |
| Recibir imagen (menú impreso, comprobante) | No |
| Recibir ubicación del cliente (delivery) | Parcial — extractor reconoce `message.type === 'location'` para logging; no resuelve dirección |
| Enviar imagen | Cumplido para QR (`sendImageFromDataUrl`) |
| Enviar video / documento (PDF menú o factura) | No |
| Catálogo nativo de WhatsApp | No — listas + botones; menos rico que `interactive.product_list` |

### 2.6 CRM, fidelización y marketing

| Feature mercado | Estado |
|-----------------|--------|
| Loyalty / puntos / niveles VIP | No — `customer` básico; sin puntos, `lifetime_value`, segmentación |
| Cupones / descuentos | No |
| Campañas broadcast (cumpleaños, reactivación, promos) | No — sin tabla `campaign` ni scheduler |
| Encuestas post-venta (CSAT/NPS) | No — `orderStatusNotification.service.ts` solo texto de status |
| Segmentación por comportamiento | No |

**Nota:** segundo gran gap competitivo. Ya hay datos (`orders`, `conversation_message`, `customer`); falta capa de marketing automation.

### 2.7 Operación y backoffice

| Feature mercado | Estado |
|-----------------|--------|
| Inbox unificado staff con SLA | Parcial — `is_human_handled`, eventos `emitAdminWhatsappMessageCreated` por socket; sin panel de cola/SLA |
| Asignación a operadores | No |
| Métricas conversación (CSAT, AHT, resolución) | No — solo costos IA (`ai_prompt_tokens`, `ai_estimated_cost_usd`) |
| Multi-canal (Instagram, FB Messenger, web widget) | No — solo WhatsApp |
| Multi-idioma (detección + respuesta) | No — copy y prompts en español rioplatense hardcodeado |
| Multi-tenant / multi-sucursal | Cumplido a nivel `business`; varias sucursales hoy vía **businesses separados**, no branch dentro del mismo business |

### 2.8 Integraciones

| Feature mercado | Estado |
|-----------------|--------|
| POS (Toast, Square, Fudo, Maxirest) | No — orden solo en Postgres propio |
| KDS (Kitchen Display) | No — admin panel manual |
| Plataformas delivery (Rappi, PedidosYa, Uber Eats) | No — sin sincronización |
| ERP / contabilidad | No |
| Webhook saliente para terceros | No |

### 2.9 IA avanzada

| Feature mercado | Estado |
|-----------------|--------|
| Tool-calling con LLM | Implementado (fase 2) — `tools/index.ts` + `agents/reactAgent.ts` (`createReactAgent`), gate `AGENT_MODE=hybrid` |
| Memoria conversacional larga (más allá de sesión) | Parcial — `conversation_message` persiste; `detectionContext` solo N últimos |
| RAG sobre FAQs del negocio | No — `askQuestionHandler` con menú estático, sin base de conocimiento |
| Personalización por historial del cliente | No — sin uso de órdenes previas en respuestas |
| Voice ordering (transcripción → flujo) | No |
| Detección fraude / spam | No |

---

## 3. Resumen ejecutivo

### 3.1 Situación actual

Entre los repos hay un **MVP sólido**: pedidos + reservas + delivery con IA NLP. Cubre bien el camino feliz conversacional, búsqueda semántica de productos y wizard de reservas. La migración a **LangGraph** deja base extensible y alineada con política Meta 2026.

### 3.2 Fortalezas frente al mercado

- Detección de intención con LLM + fallback determinístico (muchos SaaS solo keywords).
- Búsqueda con embeddings del menú, no solo full-text.
- Wizards conversacionales: reservas y onboarding con dirección + geocoding.
- Gating por suscripción del negocio (modelo SaaS B2B).
- Arquitectura LangGraph lista para ReAct con tools.
- Workers de housekeeping (`processDraftOrderTimeouts`, idle reminders) implementados.

### 3.3 Brechas críticas (impacto × esfuerzo)

Orden sugerido por **impacto comercial** frente a **esfuerzo**:

| Prioridad | Brecha | Impacto | Esfuerzo | Nota |
|-----------|--------|---------|----------|------|
| 1 | Pagos integrados (MercadoPago/Stripe) | Alto | Medio | Bloqueador #1 clientes serios |
| 2 | WhatsApp Message Templates (HSM) | Alto | Bajo | Política Meta 2026 fuera ventana 24 h |
| 3 | Multimedia entrante (audio + imagen + location) | Alto | Medio | Voice ordering como diferenciador 2026 |
| 4 | CRM / loyalty / cupones | Alto | Alto | Narrativa mercado “CLV +30%” |
| 5 | Campañas / broadcast / recordatorios reserva | Medio | Medio | `campaign` + scheduler + templates |
| 6 | Encuestas post-venta (CSAT) | Medio | Bajo | Plantilla + tabla `feedback` |
| 7 | Multi-idioma con detección | Medio | Medio | Depende mercado; prompts dejan de fijar español |
| 8 | Inbox unificado SLA + asignación | Medio (SaaS B2B) | Alto | |
| 9 | Integración POS + aggregators delivery | Alto (grandes) | Muy alto | Caso por caso |
| 10 | RAG FAQs del negocio | Bajo–medio | Bajo | Mejora `askQuestionHandler` y `productAttributeQuestionHandler` |

---

## 4. Riesgos técnicos heredados

Para agentes: items concretos de deuda / inconsistencias.

| Riesgo | Detalle |
|--------|---------|
| Handlers huérfanos | `confirmAddActionHandler.ts` y `conversationOrchestrator.service.ts` no registrados; ruido en review |
| WhatsApp sender | Sin `sendTemplateMessage` ni `sendCatalogMessage` |
| `payment_status` | Solo `unpaid` \| `paid`; sin `pending`, `failed`, `refunded` — insuficiente para pasarela real |
| Preferencias cliente | `customer` sin preferencias agregadas (alergias, favoritos); conversación sí guarda contexto |
| Tests | Sin suite automática; solo runner de paridad manual |

---

## 5. Próximo trimestre sugerido

Objetivo: **lanzar Argentina con paridad competitiva**. Orden propuesto:

1. **Templates HSM** + endpoint pasarela **MercadoPago** (1–2 sprints).
2. **Recordatorios proactivos reserva** + encuesta **CSAT** (1 sprint).
3. **Multimedia entrante:** audio (Whisper) + location resuelta a dirección (1–2 sprints).
4. **Loyalty MVP:** tabla `customer_loyalty`, comando `MIS_PUNTOS`, cupón aplicable en `checkout.service` (2 sprints).
5. **Inbox staff** con asignación + SLA básico, reutilizando socket / `adminSocket` (2 sprints).
6. **RAG FAQs** del negocio (1 sprint; embeddings ya disponibles).

**Meta comparativa:** paridad con Wazzy, Wati o AiSensy en features core; ventaja en calidad NLP vía stack LangGraph.

---

## Apéndice: referencias rápidas para búsqueda en código

Palabras clave útiles para localizar implementación o huecos:

`detectIntentWithConfidence` · `ConversationIntent` · `generateProductAwareResponse` · `is_human_handled` · `WhatsAppSenderService` · `notifyCustomerOrderStatusFromAdmin` · `detection.service.ts` · `MenuService` · `whatsappBuilders` · `searchMenuItemsByKeyword` · `peopleCountGate` · `complementSuggestions` · `showComplementSuggestionsHandler` · `reservation.service` · `viewQrHandler` · `address.service` · `business_coverage_zone` · `AGENT_MODE` · `reactAgent.ts` · `tools/index.ts` · `askQuestionHandler` · `processDraftOrderTimeouts`
