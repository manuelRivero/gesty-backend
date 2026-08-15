/**
 * PLAN-ACCION-OWNER-AUDIO.md — servicio de Speech-to-Text (D6: gate de cuota
 * de IA antes del llamado; sin lanzar nunca, siempre resultado tipado).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockedTranscriptionsCreate } = vi.hoisted(() => ({
  mockedTranscriptionsCreate: vi.fn(),
}));

vi.mock('openai', () => ({
  default: function MockOpenAI() {
    return { audio: { transcriptions: { create: mockedTranscriptionsCreate } } };
  },
  toFile: vi.fn(async (buffer: Buffer, filename: string) => ({ buffer, filename })),
}));

vi.mock('../../subscriptionBotAccess.service', () => ({
  evaluateSubscriptionForBotAi: vi.fn(),
}));

vi.mock('../aiUsage.service', () => ({
  incrementUsage: vi.fn().mockResolvedValue(undefined),
}));

import { evaluateSubscriptionForBotAi } from '../../subscriptionBotAccess.service';
import { incrementUsage } from '../aiUsage.service';
import { transcribeOwnerAudio } from '../speechToText.service';

const mockedEvaluateSubscription = evaluateSubscriptionForBotAi as unknown as ReturnType<typeof vi.fn>;
const mockedIncrementUsage = incrementUsage as unknown as ReturnType<typeof vi.fn>;

function buildBusiness(overrides: Partial<Record<string, unknown>> = {}): any {
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

describe('speechToText.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedEvaluateSubscription.mockResolvedValue({ ok: true, business: buildBusiness() });
  });

  it('transcribe y contabiliza el uso en éxito', async () => {
    mockedTranscriptionsCreate.mockResolvedValueOnce({
      text: 'cuánto vendí hoy',
      usage: { total_tokens: 120 },
    });

    const result = await transcribeOwnerAudio({
      business: buildBusiness(),
      audioBuffer: Buffer.from('fake-audio'),
      mimeType: 'audio/ogg',
    });

    expect(result).toEqual({ ok: true, transcript: 'cuánto vendí hoy' });
    expect(mockedIncrementUsage).toHaveBeenCalledWith('biz-1', 120);
  });

  it('devuelve reason "empty" sin lanzar si el transcript es demasiado corto', async () => {
    mockedTranscriptionsCreate.mockResolvedValueOnce({ text: ' ', usage: { total_tokens: 10 } });

    const result = await transcribeOwnerAudio({
      business: buildBusiness(),
      audioBuffer: Buffer.from('fake-audio'),
      mimeType: 'audio/ogg',
    });

    expect(result).toEqual({ ok: false, reason: 'empty' });
  });

  it('devuelve reason "stt_failed" sin lanzar si el llamado a OpenAI falla (incluye timeout)', async () => {
    mockedTranscriptionsCreate.mockRejectedValueOnce(new Error('Request timed out'));

    const result = await transcribeOwnerAudio({
      business: buildBusiness(),
      audioBuffer: Buffer.from('fake-audio'),
      mimeType: 'audio/ogg',
    });

    expect(result).toEqual({ ok: false, reason: 'stt_failed' });
  });

  it('devuelve reason "no_quota" y no llama a OpenAI si el negocio tiene ai_blocked', async () => {
    const result = await transcribeOwnerAudio({
      business: buildBusiness({ ai_blocked: true }),
      audioBuffer: Buffer.from('fake-audio'),
      mimeType: 'audio/ogg',
    });

    expect(result).toEqual({ ok: false, reason: 'no_quota' });
    expect(mockedTranscriptionsCreate).not.toHaveBeenCalled();
  });

  it('devuelve reason "no_quota" si la suscripción de trial ya no tiene acceso a IA', async () => {
    mockedEvaluateSubscription.mockResolvedValueOnce({ ok: false, message: 'Sin cuota' });

    const result = await transcribeOwnerAudio({
      business: buildBusiness(),
      audioBuffer: Buffer.from('fake-audio'),
      mimeType: 'audio/ogg',
    });

    expect(result).toEqual({ ok: false, reason: 'no_quota' });
    expect(mockedTranscriptionsCreate).not.toHaveBeenCalled();
  });

  it('devuelve reason "no_quota" si el negocio superó su límite mensual de tokens', async () => {
    mockedEvaluateSubscription.mockResolvedValueOnce({
      ok: true,
      business: buildBusiness({ ai_monthly_token_limit: 1000, ai_monthly_tokens_used: 1000 }),
    });

    const result = await transcribeOwnerAudio({
      business: buildBusiness(),
      audioBuffer: Buffer.from('fake-audio'),
      mimeType: 'audio/ogg',
    });

    expect(result).toEqual({ ok: false, reason: 'no_quota' });
    expect(mockedTranscriptionsCreate).not.toHaveBeenCalled();
  });
});
