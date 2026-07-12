/**
 * Test del interrupt determinista de escalamiento a humano (V-02, ADR-0002).
 *
 * Verifica que el gate se dispara por texto libre inequívoco y por el botón
 * SUPPORT, sin depender del LLM, y que ignora texto ambiguo.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../repositories/conversationState.repository', () => ({
  findOrCreateConversationState: vi.fn(),
  updateConversationState: vi.fn(),
}));

vi.mock('../../../../socket/adminSocket', () => ({
  emitAdminWhatsappSupportRequested: vi.fn(),
}));

import { escalationGateNode } from '../escalation';
import {
  findOrCreateConversationState,
  updateConversationState,
} from '../../../../repositories/conversationState.repository';
import { emitAdminWhatsappSupportRequested } from '../../../../socket/adminSocket';
import type { AgentState } from '../../../state';

const baseState = (overrides: Partial<AgentState> = {}): AgentState =>
  ({
    conversationId: 'conv-1',
    business: { id: 'biz-1' } as never,
    customer: { id: 'cust-1', phone_number: '+5491100000000', name: 'Juan' } as never,
    webhookContext: { message: { type: 'text', text: { body: '' } } } as never,
    ...overrides,
  }) as AgentState;

const withText = (body: string): AgentState =>
  baseState({ webhookContext: { message: { type: 'text', text: { body } } } as never });

describe('escalationGateNode — interrupt determinista (V-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('escala con una frase inequívoca de pedido de humano', async () => {
    const result = await escalationGateNode(withText('quiero hablar con una persona por favor'));

    expect(result.isHumanHandover).toBe(true);
    expect(result.handlerResult).toBeTruthy();
    expect(findOrCreateConversationState).toHaveBeenCalledWith('conv-1');
    expect(updateConversationState).toHaveBeenCalledWith('conv-1', { is_human_handled: true });
    expect(emitAdminWhatsappSupportRequested).toHaveBeenCalledWith(
      'biz-1',
      expect.objectContaining({ conversationId: 'conv-1' })
    );
  });

  it('escala con el botón "Pedir ayuda" (payload SUPPORT) aunque no haya texto', async () => {
    const state = baseState({
      webhookContext: {
        message: { type: 'interactive' },
        payloadId: 'SUPPORT',
      } as never,
    });

    const result = await escalationGateNode(state);

    expect(result.isHumanHandover).toBe(true);
    expect(updateConversationState).toHaveBeenCalledWith('conv-1', { is_human_handled: true });
  });

  it('NO escala con texto ambiguo que menciona "persona" sin pedir contacto humano', async () => {
    const result = await escalationGateNode(withText('somos 4 personas para comer'));

    expect(result).toEqual({});
    expect(updateConversationState).not.toHaveBeenCalled();
  });

  it('NO escala con una consulta normal del carrito', async () => {
    const result = await escalationGateNode(withText('quiero agregar una milanesa'));

    expect(result).toEqual({});
    expect(updateConversationState).not.toHaveBeenCalled();
  });

  it('no revienta si falta conversationId', async () => {
    const state = withText('quiero hablar con un humano');
    (state as { conversationId: string | null }).conversationId = null;

    const result = await escalationGateNode(state);

    expect(result).toEqual({});
    expect(updateConversationState).not.toHaveBeenCalled();
  });
});
