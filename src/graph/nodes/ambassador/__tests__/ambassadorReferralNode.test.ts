import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../integrations/ambassadors/client', () => ({
  validateAmbassadorCode: vi.fn(),
}));

vi.mock('../../../../repositories/conversationState.repository', () => ({
  patchConversationMetadata: vi.fn(),
}));

import { validateAmbassadorCode } from '../../../../integrations/ambassadors/client';
import { patchConversationMetadata } from '../../../../repositories/conversationState.repository';
import { ambassadorReferralNode } from '../index';
import type { AgentState } from '../../../state';

const mockedValidate = validateAmbassadorCode as unknown as ReturnType<typeof vi.fn>;
const mockedPatch = patchConversationMetadata as unknown as ReturnType<typeof vi.fn>;

const baseState = (overrides: Partial<AgentState> = {}): AgentState =>
  ({
    conversationId: 'conv-1',
    businessConfig: { ambassadors_enabled: true } as never,
    webhookContext: {
      message: { type: 'text', text: { body: 'DS_REF=AMB-7F3K9X hola quiero pedir' } },
    } as never,
    ...overrides,
  }) as AgentState;

describe('ambassadorReferralNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no llama a la API si ambassadors_enabled está en false', async () => {
    const result = await ambassadorReferralNode(
      baseState({ businessConfig: { ambassadors_enabled: false } as never })
    );

    expect(mockedValidate).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it('no llama a la API si el mensaje no contiene DS_REF', async () => {
    const result = await ambassadorReferralNode(
      baseState({
        webhookContext: { message: { type: 'text', text: { body: 'Hola quiero un pedido' } } } as never,
      })
    );

    expect(mockedValidate).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it('ignora mensajes no-texto (interactivo, imagen, etc.)', async () => {
    const result = await ambassadorReferralNode(
      baseState({ webhookContext: { message: { type: 'interactive' } } as never })
    );

    expect(mockedValidate).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it('código válido: persiste la referencia y sanea el texto del webhookContext', async () => {
    mockedValidate.mockResolvedValueOnce({ valid: true, publicCode: 'AMB-7F3K9X', status: 'ACTIVE' });

    const result = await ambassadorReferralNode(baseState());

    expect(mockedValidate).toHaveBeenCalledWith('AMB-7F3K9X');
    expect(mockedPatch).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        ambassador_ref: expect.objectContaining({ code: 'AMB-7F3K9X' }),
      })
    );
    expect(result.webhookContext?.message.text.body).toBe('hola quiero pedir');
  });

  it('código inválido: no persiste nada pero igual sanea el texto', async () => {
    mockedValidate.mockResolvedValueOnce({ valid: false });

    const result = await ambassadorReferralNode(baseState());

    expect(mockedPatch).not.toHaveBeenCalled();
    expect(result.webhookContext?.message.text.body).toBe('hola quiero pedir');
  });

  it('fallo de la API de validación no rompe el turno (no persiste, sanea igual)', async () => {
    mockedValidate.mockRejectedValueOnce(new Error('network down'));

    const result = await ambassadorReferralNode(baseState());

    expect(mockedPatch).not.toHaveBeenCalled();
    expect(result.webhookContext?.message.text.body).toBe('hola quiero pedir');
  });
});
