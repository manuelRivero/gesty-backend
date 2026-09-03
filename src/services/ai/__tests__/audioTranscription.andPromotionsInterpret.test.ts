/**
 * Tests de audio transcription + endpoint admin promotions/interpret (audio).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const { mockedTranscriptionsCreate } = vi.hoisted(() => ({
  mockedTranscriptionsCreate: vi.fn(),
}));

vi.mock('openai', () => ({
  default: function MockOpenAI() {
    return { audio: { transcriptions: { create: mockedTranscriptionsCreate } } };
  },
  toFile: vi.fn(async (buffer: Buffer, filename: string) => ({ buffer, filename })),
}));

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    business: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../billing/evaluateBusinessBillingAccess.service', () => ({
  evaluateBusinessBillingAccess: vi.fn(),
}));

vi.mock('../aiUsage.service', () => ({
  incrementUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../promotions/promotionInterpreter.service', () => ({
  interpretPromotionText: vi.fn(),
}));

import { prisma } from '../../../lib/prisma';
import { evaluateBusinessBillingAccess } from '../../billing/evaluateBusinessBillingAccess.service';
import { interpretPromotionText } from '../../promotions/promotionInterpreter.service';
import { transcribeAudio } from '../audioTranscription.service';
import { detectAudioMimeFromBuffer } from '../../../middleware/audioUpload.middleware';
import { interpretPromotionHandler } from '../../../controllers/adminPromotions.controller';

const mockedFindUnique = prisma.business.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedEvaluate = evaluateBusinessBillingAccess as unknown as ReturnType<typeof vi.fn>;
const mockedInterpret = interpretPromotionText as unknown as ReturnType<typeof vi.fn>;

function buildBusiness(overrides: Record<string, unknown> = {}) {
  return {
    id: 'biz-1',
    ai_blocked: false,
    ai_plan: 'basic',
    ai_monthly_token_limit: null,
    ai_monthly_tokens_used: 0,
    ai_reset_at: null,
    ...overrides,
  };
}

/** Buffer mínimo con magic bytes OggS. */
function fakeOggBuffer(): Buffer {
  const buf = Buffer.alloc(64, 0);
  buf.write('OggS', 0, 'ascii');
  return buf;
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe('audioTranscription.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('transcribe un buffer de audio de prueba', async () => {
    mockedTranscriptionsCreate.mockResolvedValueOnce({
      text: 'Los martes, de 18 a 20, si alguien compra dos hamburguesas le regalamos papas.',
      usage: { total_tokens: 40 },
    });

    const result = await transcribeAudio({
      audioBuffer: fakeOggBuffer(),
      mimeType: 'audio/ogg',
      language: 'es',
    });

    expect(result.text).toContain('hamburguesas');
    expect(result.language).toBe('es');
    expect(result.usageTokens).toBe(40);
  });
});

describe('detectAudioMimeFromBuffer', () => {
  it('detecta OGG por magic bytes', () => {
    expect(detectAudioMimeFromBuffer(fakeOggBuffer())).toBe('audio/ogg');
  });

  it('rechaza buffer sin firma conocida', () => {
    expect(detectAudioMimeFromBuffer(Buffer.from('not-audio'))).toBeNull();
  });
});

describe('interpretPromotionHandler (audio)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFindUnique.mockResolvedValue(buildBusiness());
    mockedEvaluate.mockResolvedValue({ ok: true, business: buildBusiness() });
    mockedTranscriptionsCreate.mockResolvedValue({
      text: 'Los martes, de 18 a 20, si alguien compra dos hamburguesas le regalamos papas.',
      usage: { total_tokens: 25 },
    });
    mockedInterpret.mockResolvedValue({
      status: 'needs_clarification',
      offer: {
        name: 'Martes de hamburguesas',
        conditions: [
          {
            field: 'cart.product',
            operator: 'gte',
            value: { productName: 'hamburguesa', quantity: 2 },
          },
        ],
        benefit: { type: 'free_product', productName: 'papas', quantity: 1 },
        validity: {
          daysOfWeek: [2],
          timeRange: { from: '18:00', to: '20:00' },
        },
      },
      missingInformation: [],
      unresolvedEntities: [
        {
          type: 'product',
          text: 'hamburguesa',
          path: 'offer.conditions[0].value.productName',
        },
        {
          type: 'product',
          text: 'papas',
          path: 'offer.benefit.productName',
        },
      ],
    });
  });

  it('transcribe audio de prueba e interpreta con la misma estructura que texto', async () => {
    const req = {
      user: { businessId: 'biz-1', userId: 'u1', role: 'OWNER' },
      headers: { 'content-type': 'multipart/form-data; boundary=---' },
      body: { type: 'audio' },
      file: {
        buffer: fakeOggBuffer(),
        mimetype: 'audio/ogg',
        originalname: 'promo.ogg',
      },
    } as unknown as Request;

    const res = mockRes();
    await interpretPromotionHandler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      input: { type: string };
      transcription: { text: string; language?: string };
      interpretation: { status: string; offer: { name: string } };
    };
    expect(body.input.type).toBe('audio');
    expect(body.transcription.text).toContain('hamburguesas');
    expect(body.interpretation.status).toBe('needs_clarification');
    expect(body.interpretation.offer.name).toBe('Martes de hamburguesas');
    expect(mockedInterpret).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: 'biz-1',
        text: expect.stringContaining('hamburguesas'),
      })
    );
  });

  it('rechaza audio sin magic bytes válidos', async () => {
    const req = {
      user: { businessId: 'biz-1', userId: 'u1', role: 'OWNER' },
      headers: { 'content-type': 'multipart/form-data' },
      body: { type: 'audio' },
      file: {
        buffer: Buffer.from('fake'),
        mimetype: 'audio/ogg',
        originalname: 'promo.ogg',
      },
    } as unknown as Request;

    const res = mockRes();
    await interpretPromotionHandler(req, res);

    expect(res.statusCode).toBe(400);
    expect(mockedTranscriptionsCreate).not.toHaveBeenCalled();
  });

  it('interpreta texto JSON sin transcripción', async () => {
    const req = {
      user: { businessId: 'biz-1', userId: 'u1', role: 'OWNER' },
      headers: { 'content-type': 'application/json' },
      body: {
        type: 'text',
        text: 'Los martes, de 18 a 20, si alguien compra dos hamburguesas le regalamos papas.',
      },
    } as unknown as Request;

    const res = mockRes();
    await interpretPromotionHandler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      input: { type: string; text: string };
      transcription: null;
      interpretation: { status: string };
    };
    expect(body.input.type).toBe('text');
    expect(body.transcription).toBeNull();
    expect(body.interpretation.status).toBe('needs_clarification');
    expect(mockedTranscriptionsCreate).not.toHaveBeenCalled();
  });
});
