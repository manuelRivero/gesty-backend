/**
 * Entrypoint HTTP del agente WhatsApp basado en LangGraph.
 *
 * Incluye paridad completa con food-service-backend:
 *   - GET/POST /api/whatsapp/webhook
 *   - /api/auth, /api/admin, /api/super-admin, /checkin, /api/public
 *   - Socket.IO panel admin (attachAdminSocket)
 *
 * Worker `processDraftOrderTimeouts` se ejecuta cada 60s.
 */

import 'dotenv/config';
import './types/express';
import { createServer } from 'http';
import path from 'node:path';
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import { attachAdminSocket } from './socket/adminSocket';
import authRoutes from './routes/auth.routes';
import adminOrdersRoutes from './routes/adminOrders.routes';
import superAdminRoutes from './routes/superAdmin.routes';
import checkinRoutes from './routes/checkin.routes';
import publicRoutes from './routes/public.routes';

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

/** Raíz del repo (src/ o dist/ → un nivel arriba). Sirve el visor estático del doc de producto. */
const REPO_ROOT = path.join(__dirname, '..');

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

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminOrdersRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/checkin', checkinRoutes);
app.use('/api/public', publicRoutes);

app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'food-service-agent',
    description:
      'Agente WhatsApp basado en LangGraph (paridad con food-service-backend)',
    mode: env.AGENT_MODE,
    status: 'OK',
    docs: {
      pendingFeaturesHtml: `/docs/pending-features`,
      pendingFeaturesMarkdown: `/docs/PENDING-FEATURES.md`,
    },
  });
});

/** Vista HTML de PENDING-FEATURES.md (necesita HTTP; mismo origen que el fetch del .md). */
app.get('/docs/pending-features', (_req: Request, res: Response) => {
  res.sendFile(path.join(REPO_ROOT, 'index.html'));
});

app.get('/docs/PENDING-FEATURES.md', (_req: Request, res: Response) => {
  res.type('text/markdown; charset=utf-8');
  res.sendFile(path.join(REPO_ROOT, 'PENDING-FEATURES.md'));
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
const httpServer = createServer(app);
attachAdminSocket(httpServer);

httpServer.listen(PORT, () => {
  console.log(
    `[food-service-agent] listening on http://localhost:${PORT} (mode=${env.AGENT_MODE})`
  );
  console.log(
    `[food-service-agent] pending features doc: http://localhost:${PORT}/docs/pending-features`
  );
});

export default app;
