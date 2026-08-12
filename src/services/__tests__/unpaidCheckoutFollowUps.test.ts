import { describe, expect, it } from 'vitest';
import { buildUnpaidCheckoutFollowUps } from '../checkout.service';
import { buildOrderDispatchThanksMessage } from '../productQuery/botMessages';

describe('buildUnpaidCheckoutFollowUps', () => {
  it('efectivo: QR + aviso de despacho', () => {
    const followUps = buildUnpaidCheckoutFollowUps({
      qrDataUrl: 'data:image/png;base64,xx',
      includeQr: true,
      isBankTransfer: false,
    });
    expect(followUps).toEqual([
      { type: 'image', dataUrl: 'data:image/png;base64,xx' },
      { type: 'text', message: buildOrderDispatchThanksMessage() },
    ]);
  });

  it('transferencia: no dice que el pedido va a despacharse', () => {
    const followUps = buildUnpaidCheckoutFollowUps({
      qrDataUrl: 'data:image/png;base64,xx',
      includeQr: true,
      isBankTransfer: true,
    });
    expect(followUps).toEqual([
      { type: 'image', dataUrl: 'data:image/png;base64,xx' },
    ]);
    expect(JSON.stringify(followUps)).not.toMatch(/despachad/i);
  });

  it('transferencia sin QR: sin follow-ups', () => {
    const followUps = buildUnpaidCheckoutFollowUps({
      qrDataUrl: 'data:image/png;base64,xx',
      includeQr: false,
      isBankTransfer: true,
    });
    expect(followUps).toEqual([]);
  });
});
