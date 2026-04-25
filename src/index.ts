/**
 * Entrypoint HTTP del agente WhatsApp basado en LangGraph.
 *
 * Mantiene paridad con el backend original
 * ([food-service-backend/src/index.ts]) para los únicos endpoints que el bot
 * usa: `GET /api/whatsapp/webhook` (verify) y `POST /api/whatsapp/webhook`
 * (intake). El resto del proyecto (auth, admin, super-admin, checkin, socket)
 * NO se incluye en este servicio.
 *
 * Flujo del POST:
 *   1. Responder 200 inmediatamente (Meta exige ack rápido).
 *   2. Disparar `mainGraph.invoke(payload)` de forma asíncrona "fire-and-forget".
 *
 * Worker `processDraftOrderTimeouts` se sigue ejecutando cada 60s, idéntico
 * a [food-service-backend/src/index.ts].
 */

import 'dotenv/config';
import cors from 'cors';
import express, { type Request, type Response } from 'express';

import { env } from './config/env';
import { mainGraph } from './graph/mainGraph';
import { verifyWebhook as verifyWebhookService } from './services/whatsapp.service';
import { processDraftOrderTimeouts } from './workers/draftOrders';
import type { WhatsAppWebhookPayload } from './controllers/webhook/types';

const DRAFT_ORDER_TICK_MS = 60_000;
setInterval(() => {
  void processDraftOrderTimeouts().catch((err) => {
    console.error('[worker:draftOrders] tick error', err);
  });
}, DRAFT_ORDER_TICK_MS);

const app = express();

const corsOrigins = (env.CORS_ORIGIN ?? 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (corsOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'food-service-agent',
    description:
      'Agente WhatsApp basado en LangGraph (paridad con food-service-backend)',
    mode: env.AGENT_MODE,
    status: 'OK',
  });
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    mode: env.AGENT_MODE,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/whatsapp/webhook', (req: Request, res: Response) => {
  const { isValid, challenge } = verifyWebhookService(
    req.query as Record<string, unknown>
  );

  if (isValid && challenge) {
    console.log('[whatsapp:webhook] verify OK');
    res.status(200).send(challenge);
    return;
  }

  res.status(403).json({
    success: false,
    error: 'Token de verificación inválido',
  });
});

app.post(
  '/api/whatsapp/webhook',
  (req: Request<unknown, unknown, WhatsAppWebhookPayload>, res: Response) => {
    res.sendStatus(200);

    const payload = req.body;
    setImmediate(() => {
      mainGraph
        .invoke({ webhookPayload: payload })
        .catch((err) => {
          console.error('[graph] invoke error', err);
        });
    });
  }
);

app.use((err: unknown, _req: Request, res: Response, _next: unknown) => {
  console.error('[express] unhandled error', err);
  if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
});

const PORT = env.PORT;
app.listen(PORT, () => {
  console.log(
    `[food-service-agent] listening on http://localhost:${PORT} (mode=${env.AGENT_MODE})`
  );
});

export default app;
