# food-service-agent

Implementación del bot conversacional de WhatsApp con **LangGraph + LangChain** sobre Node.js / TypeScript. Reemplaza el orquestador imperativo de [`food-service-backend/src/controllers/webhook/`](../food-service-backend/src/controllers/webhook/) por un `StateGraph` donde cada guard, wizard y handler es un nodo.

Comparte la misma BD Postgres y el mismo `prisma/schema.prisma` que el backend original (sincronizado con `npm run prisma:sync`).

## Alcance

- Solo el flujo del **bot WhatsApp** (webhook + handlers + agente).
- **No** incluye: auth, super admin, panel admin (orders/menu/config/whatsapp/dashboard), check-in, sockets ni email.

## Camino conversacional

Texto libre (sin Ownership de sesión ni botón) va al **agente ReAct híbrido** con tools. Los payloads (`ADD_ITEM:`, `CHECKOUT`, `RESERVATION_*`, …) siguen el mapper. Las sesiones opcionales (Closer, reserva, dueño) se prenden con `CHECKOUT_AGENT_ENABLED`, `RESERVATION_AGENT_ENABLED`, `OWNER_ASSISTANT_ENABLED`. El onboarding no tiene flag: su agente es el único camino (el wizard legacy se borró).

### Pruebas de paridad

Ver [`scripts/parity/README.md`](./scripts/parity/README.md) para correr los
payloads de WhatsApp (texto + interactive) contra el `mainGraph` nuevo en modo
dry-run y comparar con el backend viejo.

## Arranque

```bash
cp .env.example .env
npm install
npm run prisma:sync   # sincroniza schema desde food-service-backend
npm run prisma:generate
npm run dev
```

El webhook queda en `POST /api/whatsapp/webhook` (verify en `GET /api/whatsapp/webhook`).

## Estructura

```
src/
  index.ts               # Express + webhook + worker
  config/                # env, llm singletons
  db/                    # PrismaClient
  graph/                 # StateGraph principal y subgrafos
    nodes/               # context, gates, detection, persist, send, handlers
  prompts/               # system prompts portados de services/ai
  services/              # lógica de aplicación portada (cart, menu, order, ...)
  repositories/          # acceso a datos via Prisma
  domain/                # intent, plantillas WhatsApp
  helpers/, utils/, types/
  tools/                 # (fase 2) StructuredTool LangChain (read-only)
  agents/                # (fase 2) ReAct agent (createReactAgent)
  workers/               # tareas en intervalo (draftOrders)

scripts/
  parity/                # runner de pruebas de paridad + payloads de ejemplo
```

Ver `docs/ARQUITECTURA.md` (en este repo) para el diagrama de nodos del grafo.
