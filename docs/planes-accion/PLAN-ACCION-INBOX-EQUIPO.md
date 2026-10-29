# Plan de acción — Inbox de equipo (WhatsApp)

| | |
|--|--|
| **Estado** | Fases A–C implementadas en código (`parcial` solo viewers multi-réplica) |
| **Fecha** | 2026-09-06 |
| **Repo** | `gesty-backend` |
| **Objetivo** | Ownership mínimo de chats WhatsApp (asignación + autor + ack durable) sin romper handoff bot↔humano ni inventar unread/online falsos. |
| **FEATURES.md** | `WA-05` … `WA-11` (+ baseline `WA-02`…`WA-04`) |
| **Brief** | [CONTEXTO-BACKEND-INBOX-EQUIPO.md](./CONTEXTO-BACKEND-INBOX-EQUIPO.md) |
| **SQL** | `prisma/sql/inbox_equipo_fase_a_c.sql` |
| **Worker** | `ENABLE_HANDOFF_TIMEOUT_WORKER=true` |

**Roles inbox:** solo `OWNER` / `ADMIN`. `STAFF` no tiene acceso al chat (fuera de alcance de este plan).

---

## 1. Por qué

El inbox admin era **compartido sin dueño**: varios `OWNER`/`ADMIN` veían y respondían el mismo chat. Hacía falta ops de restaurante mínima (assign, notas, viewers, canned, ack de soporte) sin suite tipo WATI ni unread server-side inventado.

---

## 2. Invariantes

| # | Invariante |
|---|------------|
| I1 | `bot_enabled` global ≠ handoff por chat (`is_human_handled`) |
| I2 | Assign **no** apaga el bot; “tomar humano” = assign + bot OFF (o `POST …/take`) |
| I3 | Unassigned + bot ON es válido (post-timeout / bot activo) |
| I4 | Assignee = `business_user.id` (membresía), no solo `AppUser.id` |
| I5 | Al reactivar bot (manual o timeout) se limpia assignee |
| I6 | Notas internas **nunca** pasan por Meta / `WhatsAppSenderService` |
| I7 | Canned = CRUD; envío = `POST …/messages` existente |
| I8 | Sin unread/online inventados; presence solo con heartbeat real |
| I9 | REST WhatsApp exige `requireRoles("OWNER","ADMIN")` (alineado al socket) |

---

## 3. Baseline en ESTE repo (post-implementación)

### Datos (`prisma/schema.prisma`)

| Modelo / campos | Uso |
|-----------------|-----|
| `conversation.assigned_business_user_id`, `assigned_at` | Ownership |
| `conversation.support_requested_at`, `support_acked_at`, `support_acked_by_business_user_id` | Cola de soporte durable |
| `conversation_message.sent_by_user_id` | Autor tipado (AppUser) |
| `conversation_note` | Notas internas |
| `canned_reply` | Respuestas rápidas |
| `conversation_state.is_human_handled` | Bot por chat (`botEnabled ≡ !is_human_handled`) |
| `business_config.allow_human_handoff`, `human_handoff_auto_timeout_minutes` | Política + timeout |

### Servicios / workers

| Pieza | Path |
|-------|------|
| Listado / filtros | `src/services/adminWhatsappMessages.service.ts` |
| Reply | `src/services/adminWhatsappReply.service.ts` |
| Bot por chat | `src/services/adminWhatsappBotControl.service.ts` |
| Helper humano | `src/services/conversationHumanHandled.service.ts` |
| Assignment / take | `src/services/conversationAssignment.service.ts` |
| Support ack | `src/services/conversationSupportAck.service.ts` |
| Notes | `src/services/conversationNotes.service.ts` |
| Canned | `src/services/cannedReplies.service.ts` |
| Viewers | `src/services/conversationViewers.service.ts` (Map in-memory, TTL 60s) |
| Handoff | `src/services/humanHandover.service.ts` |
| Timeout worker | `src/workers/humanHandoffTimeout.ts` |
| Rutas | `src/routes/adminOrders.routes.ts` |
| Socket | `src/socket/adminSocket.ts` |

---

## 4. Fases + criterio de éxito

| Fase | Entrega | Estado |
|------|---------|--------|
| **A** | Assign, take, support ack, `sentBy*`, `requireRoles`, worker timeout + `bot_auto_reactivated` | Hecho |
| **B** | Notas + viewers + eventos | Hecho (viewers single-process) |
| **C** | Canned replies CRUD | Hecho |

**Éxito (negocio):** dueño filtrable; notas sin fuga a Meta; handoff observable; timeout configurado reactiva bot y limpia assignee.

**Pendiente operativo / mejora:** aplicar SQL en entornos que aún no lo tengan; Redis para viewers si hay 2+ réplicas (`WA-09` parcial).

---

## 5. Contrato expuesto (verificado en código)

Prefijo: **`/api/admin/whatsapp/...`** · Auth: JWT + `OWNER`/`ADMIN`.

### REST

| Método | Path | Notas |
|--------|------|-------|
| `GET` | `/whatsapp/conversations` | Query: `page`, `pageSize`, `sentiment?`, `customerPhone?`, `assignedTo=me\|unassigned\|<businessUserId>`, `support=pending` |
| `GET` | `/whatsapp/messages` | + `sentByUserId`, `sentByUserName` |
| `GET`/`PATCH` | `/whatsapp/conversations/:id/bot` | `{ enabled }` · `botEnabled ≡ !is_human_handled` |
| `POST` | `/whatsapp/conversations/:id/messages` | `{ message, skipHumanTakeover? }` |
| `PATCH` | `/whatsapp/conversations/:id/assignment` | `{ businessUserId: string \| null }` |
| `POST` | `/whatsapp/conversations/:id/take` | Assign a mí + humano |
| `POST` | `/whatsapp/conversations/:id/support-ack` | Ack durable idempotente |
| `GET`/`POST` | `/whatsapp/conversations/:id/notes` | |
| `DELETE` | `/whatsapp/conversations/:id/notes/:noteId` | |
| `POST` | `/whatsapp/conversations/:id/viewing` | Heartbeat presence |
| `GET`/`POST` | `/whatsapp/canned-replies` | |
| `PATCH`/`DELETE` | `/whatsapp/canned-replies/:id` | |

Campos de conversación (listado): además de baseline (`id`, `status`, `startedAt`, `lastMessageAt`, `aiSentiment*`, `customer`, `botEnabled`, `currentIntent`):

```ts
assignedUser: null | { id: string; userId: string; name: string | null; role: string };
assignedAt: string | null;
supportRequestedAt: string | null;
supportAckedAt: string | null;
```

### Socket (`admin:whatsapp`, sala `admin:<businessId>`)

| `type` | Campos clave |
|--------|----------------|
| `whatsapp.message_created` | + `sentByUserId`, `sentByUserName` |
| `whatsapp.support_requested` | Persistencia previa en DB (`support_*`) |
| `whatsapp.support_acked` | `conversationId`, ack actor / `at` |
| `whatsapp.assignment_updated` | `conversationId`, `assignedUser`, `assignedAt` |
| `whatsapp.bot_auto_reactivated` | Worker timeout |
| `whatsapp.note_created` | `conversationId`, note DTO |
| `whatsapp.viewers_updated` | `conversationId`, `viewers[]` |

Canal aparte: `admin:conversation_sentiment` → `conversation.sentiment_updated`.

---

## 6. Fuera de alcance

- Acceso `STAFF` al inbox (`BE-14`)
- Omnicanal, broadcasts, HSM marketing (`WA-13`)
- SLA / productividad de agentes
- Copilot IA de respuestas
- Ficha CRM del cliente
- Lock exclusivo de escritura
- Unread server-side / presence global
- UI del panel (otro repo)

---

## 7. Impacto hacia consumidores (contrato)

Additive / soft-breaking para el panel:

1. Campos `assignedUser`, `assignedAt`, `supportRequestedAt`, `supportAckedAt` en conversaciones.
2. Query `assignedTo`, `support=pending`.
3. Mensajes/socket: `sentByUserId`, `sentByUserName`.
4. Endpoints assignment / take / support-ack / notes / canned / viewing.
5. Eventos socket listados arriba (incl. `bot_auto_reactivated` cuando el worker está ON).
6. Assign usa `businessUserId` (membresía).
7. Paths con prefijo `/api/admin/whatsapp/...`.
8. REST inbox exige OWNER/ADMIN.

Este repo **no** trackea filas FEATURES del admin; solo el contrato.

---

## 8. Decisiones fijadas (referencia)

| ID | Resolución |
|----|------------|
| D1 | Assign no apaga bot |
| D2 | Unassigned + bot ON válido |
| D3 | Sin lock duro; solo viewers TTL |
| D4 | Assignee = `business_user.id` |
| D5 | `assignedTo=me` resuelve membresía del JWT |
| D6 | Bot ON limpia assignee |
| D7 | Notas nunca a Meta |
| D8 | Canned vía `POST …/messages` |
| D9 | Worker respeta `human_handoff_auto_timeout_minutes` |
| D10 | `requireRoles("OWNER","ADMIN")` |
| D11 | Unread server-side fuera de A–C |
