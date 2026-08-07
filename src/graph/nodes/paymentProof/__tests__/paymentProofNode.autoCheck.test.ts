/**
 * Fase 7, Tarea 7.3 (PLAN-ACCION-COMPROBANTES-CIERRE.md): integración de
 * visión + checks determinísticos en `paymentProofNode`, en background
 * (fire-and-forget) tras responder al cliente.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../lib/prisma', () => ({
  prisma: {
    payment_proof: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    payment_method_config: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('../../../../storage', () => ({
  getStorageProvider: vi.fn(),
}));

vi.mock('../../../../integrations/whatsapp/mediaDownload', () => ({
  downloadWhatsAppMedia: vi.fn(),
}));

vi.mock('../../../../services/payment/transferProof.service', () => ({
  findOrderAwaitingTransferProof: vi.fn(),
}));

vi.mock('../../../../socket/adminSocket', () => ({
  emitAdminOrderPaymentProofReceived: vi.fn(),
  emitAdminOrderPaymentProofChecked: vi.fn(),
}));

vi.mock('../../../../services/ai/paymentProofVision.service', () => ({
  extractPaymentProofWithVision: vi.fn(),
}));

vi.mock('../../../../services/humanHandover.service', () => ({
  handOverToHuman: vi.fn(),
}));

vi.mock('../../../../controllers/webhook/sender', () => ({
  sendResponseNoContext: vi.fn(),
}));

import { prisma } from '../../../../lib/prisma';
import { getStorageProvider } from '../../../../storage';
import { downloadWhatsAppMedia } from '../../../../integrations/whatsapp/mediaDownload';
import { emitAdminOrderPaymentProofChecked } from '../../../../socket/adminSocket';
import { extractPaymentProofWithVision } from '../../../../services/ai/paymentProofVision.service';
import { handOverToHuman } from '../../../../services/humanHandover.service';
import { sendResponseNoContext } from '../../../../controllers/webhook/sender';
import { paymentProofNode, runPaymentProofAutoCheck } from '../index';
import type { AgentState } from '../../../state';
import sharp from 'sharp';

const mockedProofFindFirst = prisma.payment_proof.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedProofFindMany = prisma.payment_proof.findMany as unknown as ReturnType<typeof vi.fn>;
const mockedHandOver = handOverToHuman as unknown as ReturnType<typeof vi.fn>;
const mockedSendNoContext = sendResponseNoContext as unknown as ReturnType<typeof vi.fn>;
const mockedProofCreate = prisma.payment_proof.create as unknown as ReturnType<typeof vi.fn>;
const mockedProofUpdate = prisma.payment_proof.update as unknown as ReturnType<typeof vi.fn>;
const mockedBankConfigFindFirst = prisma.payment_method_config.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedGetStorageProvider = getStorageProvider as unknown as ReturnType<typeof vi.fn>;
const mockedDownload = downloadWhatsAppMedia as unknown as ReturnType<typeof vi.fn>;
const mockedExtractVision = extractPaymentProofWithVision as unknown as ReturnType<typeof vi.fn>;
const mockedEmitChecked = emitAdminOrderPaymentProofChecked as unknown as ReturnType<typeof vi.fn>;

const ORDER = { id: 'order-1', total_amount: 1500 as never, created_at: new Date('2026-08-07T14:00:00.000Z') };
const BUSINESS = { id: 'biz-1', whatsapp_phone_id: 'phone-1' } as never;
const CUSTOMER = { id: 'cust-1', phone_number: '5493410000000', name: 'Juan' };

/** Argumentos comunes de `runPaymentProofAutoCheck` para los tests. */
const autoCheckArgs = (overrides: Record<string, unknown> = {}) => ({
  business: BUSINESS,
  customer: CUSTOMER,
  conversationId: 'conv-1',
  order: ORDER,
  proofId: 'proof-1',
  imageBuffer: Buffer.from('img'),
  mimeType: 'image/png',
  imageReusedInOrderId: null,
  ...overrides,
});

const validExtraction = {
  kind: 'transfer_voucher',
  legibility: 'clear',
  amount: 1500,
  currency: 'ARS',
  operation_number: 'OP-1',
  transferred_at: '2026-08-07T14:30:00.000Z',
  sender_name: 'Juan',
  bank: 'MP',
  destination_alias: 'alias',
  destination_cbu: null,
  destination_holder: null,
};

async function fakePngBuffer(): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .png()
    .toBuffer();
}

describe('runPaymentProofAutoCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: deja el proof en auto_checked con extracted y los checks completos', async () => {
    mockedExtractVision.mockResolvedValueOnce(validExtraction);
    mockedBankConfigFindFirst.mockResolvedValueOnce({ bank_alias: 'alias', bank_cbu: null });
    mockedProofFindFirst.mockResolvedValueOnce(null);
    mockedProofFindMany.mockResolvedValueOnce([]);

    await runPaymentProofAutoCheck(autoCheckArgs());

    expect(mockedProofUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'proof-1' },
        data: expect.objectContaining({
          status: 'auto_checked',
          extracted: expect.objectContaining({ operation_number: 'OP-1' }),
          checks: expect.objectContaining({
            amount_matches: 'pass',
            destination_matches: 'pass',
            date_within_window: 'pass',
            operation_number_unique: 'pass',
            image_not_reused: 'pass',
          }),
        }),
      })
    );
    expect(mockedEmitChecked).toHaveBeenCalledWith('biz-1', {
      orderId: 'order-1',
      orderRef: 'ORDER1',
      proofId: 'proof-1',
      message: 'Llegó un comprobante de transferencia para el pedido #ORDER1',
    });
  });

  it('visión devuelve null: el proof queda en received, igual avisa al admin', async () => {
    mockedExtractVision.mockResolvedValueOnce(null);

    await runPaymentProofAutoCheck(autoCheckArgs());

    expect(mockedProofUpdate).not.toHaveBeenCalled();
    expect(mockedEmitChecked).toHaveBeenCalledWith('biz-1', {
      orderId: 'order-1',
      orderRef: 'ORDER1',
      proofId: 'proof-1',
      message: 'Llegó un comprobante de transferencia para el pedido #ORDER1',
    });
  });

  it('visión lanza: se degrada sin romper y avisa al admin igual', async () => {
    mockedExtractVision.mockRejectedValueOnce(new Error('boom'));

    await expect(runPaymentProofAutoCheck(autoCheckArgs())).resolves.toBeUndefined();

    expect(mockedProofUpdate).not.toHaveBeenCalled();
    expect(mockedEmitChecked).toHaveBeenCalledWith(
      'biz-1',
      expect.objectContaining({ orderId: 'order-1', proofId: 'proof-1', orderRef: 'ORDER1' })
    );
  });
});

/**
 * Fase 8: escalamiento por comprobantes incorrectos. El tope NO es de
 * comprobantes: uno que pasa los checks es plata entrando y nunca se frena.
 * `TRANSFER_PROOF_MAX_FAILED` default 3.
 */
describe('escalamiento por comprobantes fallados (Fase 8)', () => {
  const failedChecks = { amount_matches: 'fail', image_not_reused: 'pass' };
  const unknownChecks = { amount_matches: 'unknown', destination_matches: 'unknown' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedBankConfigFindFirst.mockResolvedValue({ bank_alias: 'alias', bank_cbu: null });
    mockedProofFindFirst.mockResolvedValue(null);
    // Monto que no coincide con la orden (1500) → amount_matches: 'fail'.
    mockedExtractVision.mockResolvedValue({ ...validExtraction, amount: 999 });
  });

  it('escala a humano y avisa al cliente al llegar exactamente al tope', async () => {
    mockedProofFindMany.mockResolvedValueOnce([
      { checks: failedChecks },
      { checks: failedChecks },
      { checks: failedChecks },
    ]);

    await runPaymentProofAutoCheck(autoCheckArgs());

    expect(mockedHandOver).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', businessId: 'biz-1' })
    );
    expect(mockedSendNoContext).toHaveBeenCalledWith(
      'phone-1',
      '5493410000000',
      expect.stringContaining('Una persona del local')
    );
  });

  it('no escala por debajo del tope', async () => {
    mockedProofFindMany.mockResolvedValueOnce([{ checks: failedChecks }, { checks: failedChecks }]);

    await runPaymentProofAutoCheck(autoCheckArgs());

    expect(mockedHandOver).not.toHaveBeenCalled();
    expect(mockedSendNoContext).not.toHaveBeenCalled();
  });

  it('no vuelve a escalar por encima del tope (dispara una sola vez por orden)', async () => {
    mockedProofFindMany.mockResolvedValueOnce([
      { checks: failedChecks },
      { checks: failedChecks },
      { checks: failedChecks },
      { checks: failedChecks },
    ]);

    await runPaymentProofAutoCheck(autoCheckArgs());

    expect(mockedHandOver).not.toHaveBeenCalled();
  });

  it('los checks en unknown no acercan al escalamiento', async () => {
    mockedProofFindMany.mockResolvedValueOnce([
      { checks: unknownChecks },
      { checks: unknownChecks },
      { checks: unknownChecks },
      { checks: null },
    ]);

    await runPaymentProofAutoCheck(autoCheckArgs());

    expect(mockedHandOver).not.toHaveBeenCalled();
  });

  it('un fallo al escalar no rompe el auto-chequeo ya persistido', async () => {
    mockedProofFindMany.mockRejectedValueOnce(new Error('db down'));

    await expect(runPaymentProofAutoCheck(autoCheckArgs())).resolves.toBeUndefined();

    expect(mockedProofUpdate).toHaveBeenCalled();
  });
});

/**
 * Fase 8: dedupe. La misma imagen para la misma orden no es plata nueva; se
 * corta antes de subir a R2 y antes de llamar a visión.
 */
describe('dedupe de comprobantes repetidos (Fase 8)', () => {
  let storageUpload: ReturnType<typeof vi.fn>;

  const stateWithImage = () =>
    ({
      business: BUSINESS,
      customer: CUSTOMER as never,
      conversationId: 'conv-1',
      awaitingTransferProofOrder: ORDER,
      webhookContext: { message: { type: 'image', image: { id: 'media-1' } } } as never,
    }) as unknown as AgentState;

  beforeEach(async () => {
    vi.clearAllMocks();
    storageUpload = vi.fn().mockResolvedValue({ key: 'k' });
    mockedGetStorageProvider.mockReturnValue({
      upload: storageUpload,
      getPublicUrl: vi.fn().mockReturnValue('https://cdn.example.com/proof.jpg'),
      delete: vi.fn(),
      exists: vi.fn(),
    });
    const buffer = await fakePngBuffer();
    mockedDownload.mockResolvedValue({
      buffer,
      mimeType: 'image/png',
      sha256: 'sha-abc',
      sizeBytes: buffer.length,
    });
  });

  it('no sube a R2, no crea fila ni llama a visión si la imagen ya está en esta orden', async () => {
    mockedProofFindFirst.mockResolvedValueOnce({ id: 'proof-previo' });

    const result = await paymentProofNode(stateWithImage());

    expect(storageUpload).not.toHaveBeenCalled();
    expect(mockedProofCreate).not.toHaveBeenCalled();
    expect(mockedExtractVision).not.toHaveBeenCalled();
    expect(result.handlerResult).toBeTruthy();
    expect(result.handlerResult!.content as string).toContain('ya nos había llegado');
  });

  it('una imagen distinta sigue el flujo normal', async () => {
    mockedProofFindFirst.mockResolvedValue(null);
    mockedProofCreate.mockResolvedValueOnce({ id: 'proof-nuevo' });
    mockedExtractVision.mockReturnValueOnce(new Promise(() => {}));

    const result = await paymentProofNode(stateWithImage());

    expect(storageUpload).toHaveBeenCalled();
    expect(mockedProofCreate).toHaveBeenCalled();
    expect(result.handlerResult!.content as string).not.toContain('ya nos había llegado');
  });
});

describe('paymentProofNode — no espera al auto-chequeo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetStorageProvider.mockReturnValue({
      upload: vi.fn().mockResolvedValue({ key: 'k' }),
      getPublicUrl: vi.fn().mockReturnValue('https://cdn.example.com/proof.jpg'),
      delete: vi.fn(),
      exists: vi.fn(),
    });
    mockedProofFindFirst.mockResolvedValue(null);
  });

  it('responde al cliente sin esperar a que resuelva la llamada a visión', async () => {
    const buffer = await fakePngBuffer();
    mockedDownload.mockResolvedValueOnce({
      buffer,
      mimeType: 'image/png',
      sha256: 'abc',
      sizeBytes: buffer.length,
    });
    mockedProofCreate.mockResolvedValueOnce({ id: 'proof-1' });

    // La promesa de visión nunca resuelve durante el test: si el nodo la
    // esperara, este test colgaría o el resultado no estaría disponible acá.
    mockedExtractVision.mockReturnValueOnce(new Promise(() => {}));

    const state = {
      business: BUSINESS,
      customer: { id: 'cust-1' } as never,
      conversationId: 'conv-1',
      awaitingTransferProofOrder: ORDER,
      webhookContext: { message: { type: 'image', image: { id: 'media-1' } } } as never,
    } as unknown as AgentState;

    const result = await paymentProofNode(state);

    expect(result.handlerResult).toBeTruthy();
    expect(mockedProofCreate).toHaveBeenCalled();
  });
});
