/**
 * Páginas HTML de retorno post-Checkout Pro del bot (PAY-07).
 */

import type { Request, Response } from 'express';
import {
  paymentReturnCopy,
  resolvePaymentReturnPage,
  type PaymentReturnKind,
  type PaymentReturnPageModel,
} from '../../services/payment/paymentReturnPage.service';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function queryString(
  value: unknown
): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim()) {
    return value[0].trim();
  }
  return null;
}

export function renderPaymentReturnHtml(model: PaymentReturnPageModel): string {
  const { title, subtitle } = paymentReturnCopy(model);
  const business = model.businessName
    ? escapeHtml(model.businessName)
    : 'Tu pedido';
  const metaParts: string[] = [];
  if (model.orderRef) metaParts.push(`Pedido #${escapeHtml(model.orderRef)}`);
  if (model.amountLabel) metaParts.push(escapeHtml(model.amountLabel));
  const metaLine = metaParts.length > 0 ? metaParts.join(' · ') : null;

  const cta = model.chatUrl
    ? `<a class="cta" href="${escapeHtml(model.chatUrl)}">Volver al chat</a>`
    : `<p class="hint">Volvé al chat de WhatsApp con el local para seguir.</p>`;

  const closeHint =
    'Podés cerrar esta página tranquilo: el seguimiento sigue en el chat.';

  const refreshMeta =
    model.kind === 'success' && model.confirming
      ? '<meta http-equiv="refresh" content="4">'
      : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${refreshMeta}
  <title>${escapeHtml(title)} · ${business}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --ink: #1a1f1c;
      --muted: #5c6b63;
      --accent: #1f6b4a;
      --accent-ink: #f4faf7;
      --wash-a: #e8f2ec;
      --wash-b: #f7f3ea;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "DM Sans", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(1200px 600px at 10% -10%, var(--wash-a), transparent 55%),
        radial-gradient(900px 500px at 100% 0%, #dfece4, transparent 50%),
        linear-gradient(165deg, var(--wash-b), #eef4f0 55%, #e4ebe6);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem 1.25rem;
    }
    main {
      width: min(28rem, 100%);
      text-align: left;
      background: #fff;
      border-radius: 1rem;
      padding: 1.75rem 1.5rem;
      box-shadow: 0 12px 40px rgba(26, 31, 28, 0.08);
    }
    .brand {
      font-size: 0.85rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 600;
      margin: 0 0 0.75rem;
    }
    h1 {
      font-size: clamp(1.75rem, 4vw, 2.15rem);
      line-height: 1.15;
      font-weight: 700;
      margin: 0 0 0.75rem;
    }
    .meta {
      font-size: 1rem;
      color: var(--ink);
      margin: 0 0 0.75rem;
      font-weight: 600;
    }
    .sub {
      font-size: 1.05rem;
      line-height: 1.45;
      color: var(--muted);
      margin: 0 0 1.75rem;
      max-width: 26rem;
    }
    .cta {
      display: inline-block;
      background: var(--accent);
      color: var(--accent-ink);
      text-decoration: none;
      font-weight: 600;
      padding: 0.85rem 1.35rem;
      border-radius: 0.35rem;
    }
    .cta:hover { filter: brightness(1.06); }
    .hint {
      margin: 0;
      color: var(--muted);
      font-size: 0.95rem;
    }
    .close-hint {
      margin: 1.1rem 0 0;
      color: var(--muted);
      font-size: 0.92rem;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <main>
    <p class="brand">${business}</p>
    <h1>${escapeHtml(title)}</h1>
    ${metaLine ? `<p class="meta">${metaLine}</p>` : ''}
    <p class="sub">${escapeHtml(subtitle)}</p>
    ${cta}
    <p class="close-hint">${escapeHtml(closeHint)}</p>
  </main>
</body>
</html>`;
}

async function handlePaymentReturn(
  kind: PaymentReturnKind,
  req: Request,
  res: Response
): Promise<void> {
  const model = await resolvePaymentReturnPage({
    kind,
    businessId: queryString(req.query.business_id),
    externalReference: queryString(req.query.external_reference),
    preferenceId: queryString(req.query.preference_id),
  });

  res
    .status(200)
    .type('html')
    .send(renderPaymentReturnHtml(model));
}

export const paymentReturnSuccessHandler = (
  req: Request,
  res: Response
): void => {
  void handlePaymentReturn('success', req, res).catch((err) => {
    console.error('[payment:return] success error', err);
    if (!res.headersSent) {
      res
        .status(200)
        .type('html')
        .send(
          renderPaymentReturnHtml({
            kind: 'success',
            businessName: null,
            amountLabel: null,
            orderRef: null,
            confirming: true,
            chatUrl: null,
          })
        );
    }
  });
};

export const paymentReturnFailureHandler = (
  req: Request,
  res: Response
): void => {
  void handlePaymentReturn('failure', req, res).catch((err) => {
    console.error('[payment:return] failure error', err);
    if (!res.headersSent) {
      res
        .status(200)
        .type('html')
        .send(
          renderPaymentReturnHtml({
            kind: 'failure',
            businessName: null,
            amountLabel: null,
            orderRef: null,
            confirming: false,
            chatUrl: null,
          })
        );
    }
  });
};

export const paymentReturnPendingHandler = (
  req: Request,
  res: Response
): void => {
  void handlePaymentReturn('pending', req, res).catch((err) => {
    console.error('[payment:return] pending error', err);
    if (!res.headersSent) {
      res
        .status(200)
        .type('html')
        .send(
          renderPaymentReturnHtml({
            kind: 'pending',
            businessName: null,
            amountLabel: null,
            orderRef: null,
            confirming: false,
            chatUrl: null,
          })
        );
    }
  });
};
