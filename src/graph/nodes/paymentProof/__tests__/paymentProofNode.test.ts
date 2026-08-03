/**
 * Tests de `paymentProofNode` (Tarea 4.1): descarga, storage y Prisma
 * mockeados. Cubre happy path, fallo de R2 (degradación suave, sin proof
 * huérfano) y detección de reuso de hash perceptual (D6: el proof igual se
 * crea).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../lib/prisma', () => ({
  prisma: {
    payment_proof: {
      findFirst: vi.fn(),
      create: vi.fn(),
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
}));

// sharp real: opera sobre un buffer PNG válido generado en el propio test.

import { prisma } from '../../../../lib/prisma';
import { getStorageProvider } from '../../../../storage';
import { downloadWhatsAppMedia } from '../../../../integrations/whatsapp/mediaDownload';
import { findOrderAwaitingTransferProof } from '../../../../services/payment/transferProof.service';
import { emitAdminOrderPaymentProofReceived } from '../../../../socket/adminSocket';
import { paymentProofNode } from '../index';
import { parseBotUserMessage } from '../../../../services/productQuery/utils';
import type { AgentState } from '../../../state';
import sharp from 'sharp';

const mockedFindFirst = prisma.payment_proof.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedCreate = prisma.payment_proof.create as unknown as ReturnType<typeof vi.fn>;
const mockedGetStorageProvider = getStorageProvider as unknown as ReturnType<typeof vi.fn>;
const mockedDownload = downloadWhatsAppMedia as unknown as ReturnType<typeof vi.fn>;
const mockedFindOrder = findOrderAwaitingTransferProof as unknown as ReturnType<typeof vi.fn>;
const mockedEmit = emitAdminOrderPaymentProofReceived as unknown as ReturnType<typeof vi.fn>;

const ORDER = { id: 'order-1', total_amount: null, created_at: new Date() };

const baseState = (overrides: Partial<AgentState> = {}): AgentState =>
  ({
    business: { id: 'biz-1' } as never,
    customer: { id: 'cust-1' } as never,
    conversationId: 'conv-1',
    awaitingTransferProofOrder: ORDER,
    webhookContext: { message: { type: 'image', image: { id: 'media-1' } } } as never,
    ...overrides,
  }) as AgentState;

async function fakePngBuffer(): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
}

describe('paymentProofNode', () => {
  let storageUpload: ReturnType<typeof vi.fn>;
  let storageGetPublicUrl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    storageUpload = vi.fn().mockResolvedValue({ key: 'k' });
    storageGetPublicUrl = vi.fn().mockReturnValue('https://cdn.example.com/proof.jpg');
    mockedGetStorageProvider.mockReturnValue({
      upload: storageUpload,
      getPublicUrl: storageGetPublicUrl,
      delete: vi.fn(),
      exists: vi.fn(),
    });
    mockedFindFirst.mockResolvedValue(null);
  });

  it('crea el payment_proof con los campos correctos y confirma la recepción al cliente', async () => {
    const buffer = await fakePngBuffer();
    mockedDownload.mockResolvedValueOnce({
      buffer,
      mimeType: 'image/png',
      sha256: 'abc123',
      sizeBytes: buffer.length,
    });
    mockedCreate.mockResolvedValueOnce({ id: 'proof-1' });

    const result = await paymentProofNode(baseState());

    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          business_id: 'biz-1',
          order_id: 'order-1',
          customer_id: 'cust-1',
          conversation_id: 'conv-1',
          media_mime: 'image/png',
          media_sha256: 'abc123',
          status: 'received',
        }),
      })
    );
    expect(mockedEmit).toHaveBeenCalledWith('biz-1', { orderId: 'order-1', proofId: 'proof-1' });
    expect(result.handlerResult).toBeTruthy();
    expect(parseBotUserMessage(result.handlerResult!.content as string)).not.toBeNull();
  });

  it('degrada con mensaje neutro si falla la subida a R2, sin crear proof huérfano', async () => {
    const buffer = await fakePngBuffer();
    mockedDownload.mockResolvedValueOnce({
      buffer,
      mimeType: 'image/png',
      sha256: 'abc123',
      sizeBytes: buffer.length,
    });
    storageUpload.mockRejectedValueOnce(new Error('R2 down'));

    const result = await paymentProofNode(baseState());

    expect(mockedCreate).not.toHaveBeenCalled();
    expect(result.handlerResult).toBeTruthy();
  });

  it('registra el reuso en checks y crea el proof igual (D6: no bloquea)', async () => {
    const buffer = await fakePngBuffer();
    mockedDownload.mockResolvedValueOnce({
      buffer,
      mimeType: 'image/png',
      sha256: 'abc123',
      sizeBytes: buffer.length,
    });
    mockedFindFirst.mockResolvedValueOnce({ order_id: 'order-old' });
    mockedCreate.mockResolvedValueOnce({ id: 'proof-2' });

    const result = await paymentProofNode(baseState());

    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          checks: expect.objectContaining({
            image_not_reused: 'fail',
            image_reused_in_order_id: 'order-old',
          }),
        }),
      })
    );
    expect(result.handlerResult).toBeTruthy();
  });

  it('degrada con mensaje neutro si no hay orden pendiente (defensivo, aunque el guard ya la validó)', async () => {
    mockedFindOrder.mockResolvedValueOnce(null);

    const result = await paymentProofNode(baseState({ awaitingTransferProofOrder: null }));

    expect(mockedDownload).not.toHaveBeenCalled();
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(result.handlerResult).toBeTruthy();
  });
});
