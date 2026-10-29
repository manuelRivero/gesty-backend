# Contexto para gesty-backend — Inbox de equipo (WhatsApp)

| | |
|--|--|
| **Estado** | Brief histórico (origen admin); plan backend ya existe |
| **Fecha** | 2026-09-06 |
| **Repo** | `gesty-backend` (destino); origen de producto: `gesty-admin` |
| **Objetivo** | Contexto de producto + contrato que el admin consumía, para alinear el plan backend. |
| **Plan backend** | [PLAN-ACCION-INBOX-EQUIPO.md](./PLAN-ACCION-INBOX-EQUIPO.md) |
| **FEATURES.md** | `WA-05` … `WA-11` (catálogo de **este** repo) |

**No es** el plan de implementación. El plan verificado contra código está en el link de arriba.

---

## 1. Problema de negocio (por qué)

El local de experimento opera con **muchos grupos de WhatsApp** y comunicaciones internas desordenadas.  
Hoy el panel tiene inbox **compartido sin dueño**: varios `ADMIN`/`OWNER` pueden mirar y responder el mismo chat a la vez.

Hace falta un **inbox de equipo mínimo** (ops de restaurante), no una suite tipo WATI:

1. **Asignar** chat a una persona  
2. **Notas internas** (instrucciones del equipo; no van a Meta)  
3. **Anti-colisión liviana** (ver quién está mirando)  
4. **Respuestas rápidas** (canned)  
5. Más adelante: acceso `STAFF`

---

## 2. Qué debe producir el agente de backend

Un markdown de plan de acción en `gesty-backend` (nombre sugerido: `PLAN-ACCION-INBOX-EQUIPO.md` o el convención del repo) que incluya:

1. **Baseline real** — modelos Prisma / entidades, endpoints y eventos socket que ya existen (con paths de archivo).  
2. **Brechas** — qué falta vs las fases A–C de abajo.  
3. **Diseño de datos** — tablas/campos, índices, migraciones.  
4. **Contrato API + socket** definitivo (puede corregir el borrador del admin).  
5. **Invariantes de backend** (handoff, timeout, support ack, assignment vs bot).  
6. **Fases de implementación** ordenadas, con criterio de éxito testeable.  
7. **Fuera de alcance** explícito.  
8. **Impacto en admin** — lista corta de breaking changes o campos nuevos que el panel deberá consumir (para actualizar el plan UI después).

**Importante:** no asumas que el borrador de API del admin es correcto. **Verificá el código** y ajustá nombres, auth, multi-tenant y eventos a lo que ya hace el backend.

---

## 3. Baseline que el admin ya consume (verificar en backend)

### REST

| Uso | Método / path | Body / query relevante |
|-----|---------------|------------------------|
| Listar conversaciones | `GET /admin/whatsapp/conversations` | `page`, `pageSize` (máx 100), `sentiment?`, `customerPhone?` |
| Listar mensajes | `GET /admin/whatsapp/messages` | `page`, `pageSize`, `conversationId?`, `customerPhone?` |
| Estado bot por chat | `GET /admin/whatsapp/conversations/:id/bot` | → boolean |
| Toggle bot por chat | `PATCH /admin/whatsapp/conversations/:id/bot` | `{ enabled }` |
| Enviar mensaje humano | `POST /admin/whatsapp/conversations/:id/messages` | `{ message, skipHumanTakeover? }` |

Código admin: `lib/requests/messages.ts`.

### Campos de conversación que el admin ya mapea

- `id`, `status` (`open` \| `closed`), `startedAt`, `lastMessageAt`
- `aiSentiment`, `aiSentimentUpdatedAt`
- `customer` `{ id, name, phoneNumber }`
- `botEnabled`, `currentIntent` (mapeado; UI casi no usa intent/status)

### Mensajes

- `id`, `sender` (string), `message`, `isAiGenerated`, `createdAt`
- **Hoy no hay** `sentByUserId` / nombre del admin que envió

### Socket (canal admin)

| Evento | Uso actual en UI |
|--------|------------------|
| `whatsapp.message_created` | Append mensaje + unread local |
| `whatsapp.support_requested` | Badge/toast/audio; **ack solo en React** (no durable) |
| `whatsapp.bot_auto_reactivated` | Fuerza bot ON + mensaje reengage |
| `conversation.sentiment_updated` | Banner + toasts de sentimiento negativo |

Config de negocio relacionada (Settings): `bot_enabled`, `allow_human_handoff`, `human_handoff_auto_timeout_minutes`.

### Roles hoy en admin

- Inbox `/messages`: solo **`ADMIN`** y **`OWNER`**
- `STAFF` / `DELIVERY` no entran al inbox
- Asignación de delivery en **pedidos** sí existe; en WhatsApp **no**

---

## 4. Invariantes de producto (el plan backend debe respetarlos o documentar excepción)

| # | Invariante |
|---|------------|
| I1 | `bot_enabled` **global** ≠ handoff por conversación. |
| I2 | Input humano en UI solo con bot de conversación OFF. |
| I3 | `skipHumanTakeover: true` solo en reengage del bot; mensajes humanos hacen takeover. |
| I4 | **Notas internas nunca** se envían a WhatsApp/Meta. |
| I5 | **Asignar no apaga el bot solo.** Preferencia producto: CTA explícito “Tomar y pasar a humano” (assign + bot OFF) vs “Solo asignar”. |
| I6 | Auto-reactivación por timeout debe seguir funcionando; definir qué pasa con `assignedUser` al volver el bot. |
| I7 | Ack de `support_requested` debe ser **persistente** (hoy es solo cliente). |
| I8 | No inventar unread/online falsos; si se exponen, que sean reales. |

---

## 5. Fases deseadas (producto) — borrador de contrato

El admin propuso esto; **el backend puede renombrar paths/campos** si encaja mejor con el dominio existente.

### Fase A — Ownership (prioridad #1)

Problema: nadie sabe de quién es el chat.

Necesidades backend (mínimo):

- `assignedUserId` / `assignedAt` (nullable) en conversación  
- `PATCH …/assignment` `{ userId: string | null }`  
- Filtro listado: `assignedTo=me|unassigned|<userId>`  
- Assignee en `GET conversations` + evento de actualización  
- Support ack durable  
- `sentByUserId` (+ nombre) en mensajes admin / realtime  

### Fase B — Viewers + notas internas

- Presence/viewers con TTL (anti-colisión **liviana**, no lock duro en MVP)  
- CRUD notas por conversación (nunca a Meta)  
- Eventos socket para viewers / nota creada  

### Fase C — Canned replies

- CRUD a nivel **business**  
- El envío al cliente sigue siendo el `POST …/messages` actual  

### Fase D — STAFF en inbox (después de A–C)

- Solo cuando ownership + autor de mensaje existan  
- No abrir más roles al caos actual  

### Decisiones abiertas (backend debe fijar o proponer)

| ID | Pregunta | Preferencia admin |
|----|----------|-------------------|
| D1 | ¿Assign apaga bot? | No automático |
| D2 | ¿Unassigned + bot ON válido? | Sí |
| D3 | ¿Lock duro al escribir? | No en MVP |
| D6 | ¿Al auto-reactivar bot se limpia assignee? | Decidir en backend y documentar |

---

## 6. Fuera de alcance (no meter en el plan backend de inbox)

- Omnicanal, broadcasts, templates marketing Meta  
- SLA / reportes de productividad de agentes  
- Copilot IA de respuestas  
- Ficha CRM del cliente en el chat (gap #3, otro plan)  
- Migrar grupos de WhatsApp del laboratorio a Gesty  
- Reimplementar handoff/timeout desde cero (extender lo que ya hay)

---

## 7. Criterio de éxito (negocio)

1. Un chat de soporte tiene **dueño visible** para todo el equipo del local.  
2. Las instrucciones operativas pueden vivir en **notas internas**.  
3. Dos humanos no “descubren” al otro solo cuando ya respondieron (viewers o al menos assignee).  
4. Handoff bot↔humano y timeout **siguen iguales** en comportamiento observable.  

---

## 8. Cómo devolver el output

**Hecho en este repo:** [PLAN-ACCION-INBOX-EQUIPO.md](./PLAN-ACCION-INBOX-EQUIPO.md) (Fases A–C en código) + filas `WA-05`…`WA-11` en [`docs/FEATURES.md`](../FEATURES.md).

Pendiente en **gesty-admin** (otro repo): actualizar su plan UI y su propio catálogo contra el **Contrato expuesto** del plan backend.

---

## 9. Prompt sugerido (histórico)

> Leé `docs/planes-accion/CONTEXTO-BACKEND-INBOX-EQUIPO.md`.  
> Contrastá con el código real y el plan [PLAN-ACCION-INBOX-EQUIPO.md](./PLAN-ACCION-INBOX-EQUIPO.md).

---

## 10. Archivos relacionados en gesty-admin (referencia)

| Archivo | Para qué |
|---------|----------|
| `docs/planes-accion/PLAN-ACCION-INBOX-EQUIPO.md` | Plan UI (actualizar contra contrato backend) |
| `docs/FEATURES.md` | Catálogo del admin (IDs propios de ese repo) |
| `lib/requests/messages.ts` | Contrato HTTP que el admin usa |
| `contexts/admin-socket-context.tsx` | Eventos socket |
| `app/(dashboard)/messages/page.tsx` | Orquestación UI |
| `lib/requests/business-config.ts` | `allow_human_handoff`, timeout, `bot_enabled` |
