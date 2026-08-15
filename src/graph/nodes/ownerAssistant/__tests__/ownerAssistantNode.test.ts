import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../agents/ownerAssistantAgent', () => ({
  runOwnerAssistantAgent: vi.fn(),
}));

import { runOwnerAssistantAgent } from '../../../../agents/ownerAssistantAgent';
import { ownerAssistantAgentNode } from '../index';
import type { AgentState } from '../../../state';

const baseState = (): AgentState =>
  ({
    conversation: { id: 'conv-1' },
    conversationId: 'conv-1',
    enrichedCtx: {
      conversationId: 'conv-1',
      message: { text: { body: 'cómo va el día' } },
    },
  }) as AgentState;

describe('ownerAssistantAgentNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('devuelve el texto del agente y delega (salta post-gates de cliente)', async () => {
    vi.mocked(runOwnerAssistantAgent).mockResolvedValue({
      text: '🤖\n\n*Tu local* 📊\n\n10 pedidos hoy, sin quejas.',
      signals: {},
    });

    const result = await ownerAssistantAgentNode(baseState());

    expect(result.dataCollectionDelegated).toBe(true);
    expect(result.handlerResult).toEqual({
      content: '🤖\n\n*Tu local* 📊\n\n10 pedidos hoy, sin quejas.',
      isInteractive: false,
    });
  });

  it('si el agente falla, el fallback ofrece atajos (no un mensaje muerto)', async () => {
    vi.mocked(runOwnerAssistantAgent).mockRejectedValue(new Error('llm down'));

    const result = await ownerAssistantAgentNode(baseState());

    expect(result.dataCollectionDelegated).toBe(true);
    const content = String(result.handlerResult?.content);
    expect(content).toContain('*Resumen*');
    expect(content).toContain('*Cola*');
    expect(content).toContain('atajo');
  });
});
