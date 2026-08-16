import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../agents/reactAgent', () => ({
  runHybridReactAgent: vi.fn(),
}));

vi.mock('../../../../services/ai/detection.service', () => ({
  detectIntentWithConfidence: vi.fn(),
}));

import { delegateToMainWithDetection } from '../delegateToMain';
import { detectIntentWithConfidence } from '../../../../services/ai/detection.service';
import { runHybridReactAgent } from '../../../../agents/reactAgent';
import type { EnrichedContext } from '../../../../controllers/webhook/types';

describe('delegateToMainWithDetection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runHybridReactAgent).mockResolvedValue({
      kind: 'response',
      handlerResult: { content: 'ok', isInteractive: false },
    } as never);
  });

  it('invoca el híbrido sin clasificar intent', async () => {
    const result = await delegateToMainWithDetection({
      enrichedCtx: { conversation: { id: 'c1' } } as unknown as EnrichedContext,
      userMessage: 'tienen milanesas?',
      detectionContext: {
        conversationMode: 'ordering',
        lastReferencedProductId: null,
        candidateProductIds: null,
        recentMessages: [],
      },
    });

    expect(detectIntentWithConfidence).not.toHaveBeenCalled();
    expect(runHybridReactAgent).toHaveBeenCalled();
    expect(result.handlerResult?.content).toBe('ok');
  });

  it('sin mensaje es no-op', async () => {
    const result = await delegateToMainWithDetection({
      enrichedCtx: {} as EnrichedContext,
      userMessage: '   ',
      detectionContext: null,
    });

    expect(runHybridReactAgent).not.toHaveBeenCalled();
    expect(result.handlerResult).toBeNull();
  });
});
