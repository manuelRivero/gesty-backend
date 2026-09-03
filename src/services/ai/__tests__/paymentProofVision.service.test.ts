/**
 * Fase 7, Tarea 7.1 (PLAN-ACCION-COMPROBANTES-CIERRE.md): extracción con
 * visión de comprobantes de transferencia.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockedCreate } = vi.hoisted(() => ({ mockedCreate: vi.fn() }));

vi.mock('openai', () => ({
  default: function MockOpenAI() {
    return { chat: { completions: { create: mockedCreate } } };
  },
}));

vi.mock('../../billing/evaluateBusinessBillingAccess.service', () => ({
  evaluateBusinessBillingAccess: vi.fn(),
}));

vi.mock('../aiUsage.service', () => ({
  incrementUsage: vi.fn().mockResolvedValue(undefined),
}));

import { evaluateBusinessBillingAccess } from '../../billing/evaluateBusinessBillingAccess.service';
import { incrementUsage } from '../aiUsage.service';
import { extractPaymentProofWithVision } from '../paymentProofVision.service';

const mockedEvaluateSubscription = evaluateBusinessBillingAccess as unknown as ReturnType<typeof vi.fn>;
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

function chatResponse(content: string, totalTokens = 100): unknown {
  return {
    choices: [{ message: { content } }],
    usage: { total_tokens: totalTokens },
  };
}

const validExtraction = {
  kind: 'transfer_voucher',
  legibility: 'clear',
  amount: 1500.5,
  currency: 'ARS',
  operation_number: '123456',
  transferred_at: '2026-08-07T12:00:00.000Z',
  sender_name: 'Juan Pérez',
  bank: 'Mercado Pago',
  destination_alias: 'mi.alias.mp',
  destination_cbu: '0000003100010000000001',
  destination_holder: 'Local SRL',
};

describe('paymentProofVision.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedEvaluateSubscription.mockResolvedValue({ ok: true, business: buildBusiness() });
  });

  it('parsea una respuesta válida y contabiliza el uso', async () => {
    mockedCreate.mockResolvedValueOnce(chatResponse(JSON.stringify(validExtraction), 250));

    const result = await extractPaymentProofWithVision({
      business: buildBusiness(),
      imageBuffer: Buffer.from('fake-image'),
      mimeType: 'image/png',
    });

    expect(result).toEqual(validExtraction);
    expect(mockedIncrementUsage).toHaveBeenCalledWith('biz-1', 250);
  });

  it('devuelve null sin lanzar si la respuesta no valida contra el schema', async () => {
    mockedCreate.mockResolvedValueOnce(
      chatResponse(JSON.stringify({ kind: 'not_a_valid_kind' }))
    );

    const result = await extractPaymentProofWithVision({
      business: buildBusiness(),
      imageBuffer: Buffer.from('fake-image'),
      mimeType: 'image/png',
    });

    expect(result).toBeNull();
  });

  it('devuelve null sin lanzar si el llamado a OpenAI falla (incluye timeout)', async () => {
    mockedCreate.mockRejectedValueOnce(new Error('Request timed out'));

    const result = await extractPaymentProofWithVision({
      business: buildBusiness(),
      imageBuffer: Buffer.from('fake-image'),
      mimeType: 'image/png',
    });

    expect(result).toBeNull();
  });

  it('no dispara el llamado si el negocio tiene ai_blocked', async () => {
    const result = await extractPaymentProofWithVision({
      business: buildBusiness({ ai_blocked: true }),
      imageBuffer: Buffer.from('fake-image'),
      mimeType: 'image/png',
    });

    expect(result).toBeNull();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('no dispara el llamado si la suscripción de trial ya no tiene acceso a IA', async () => {
    mockedEvaluateSubscription.mockResolvedValueOnce({ ok: false, message: 'Sin cuota' });

    const result = await extractPaymentProofWithVision({
      business: buildBusiness(),
      imageBuffer: Buffer.from('fake-image'),
      mimeType: 'image/png',
    });

    expect(result).toBeNull();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('no dispara el llamado si el negocio ya superó su límite mensual de tokens', async () => {
    mockedEvaluateSubscription.mockResolvedValueOnce({
      ok: true,
      business: buildBusiness({ ai_monthly_token_limit: 1000, ai_monthly_tokens_used: 1000 }),
    });

    const result = await extractPaymentProofWithVision({
      business: buildBusiness(),
      imageBuffer: Buffer.from('fake-image'),
      mimeType: 'image/png',
    });

    expect(result).toBeNull();
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});
