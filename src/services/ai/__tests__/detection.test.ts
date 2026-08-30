import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/llm', () => ({
  getIntentDetectorLlm: vi.fn(),
}));

import {
  detectIntentWithConfidence,
  MIN_MARGIN,
  type IntentDetectionResult,
} from '../detection.service';
import { getIntentDetectorLlm } from '../../../config/llm';
import { ConversationIntent } from '../../../types/conversationIntent';

const mockStructuredIntent = (parsed: Record<string, unknown>) => {
  const invoke = vi.fn().mockResolvedValue(parsed);
  vi.mocked(getIntentDetectorLlm).mockReturnValue({
    withStructuredOutput: () => ({ invoke }),
  } as never);
  return invoke;
};

const emptyDetectionContext = {
  conversationMode: 'DEFAULT',
  lastReferencedProductId: null,
  candidateProductIds: null,
  recentMessages: [] as string[],
};

const baseDetection = (
  overrides: Partial<IntentDetectionResult>
): IntentDetectionResult => ({
  intent: ConversationIntent.UNKNOWN,
  confidence: 0,
  detectedProductName: null,
  quantity: null,
  candidates: [],
  alternatives: [],
  resolutionSource: 'unknown',
  topCandidate: null,
  rescueMargin: null,
  raw: '{}',
  ...overrides,
});

describe('detectIntentWithConfidence — sin coerce a PRODUCT_QUERY', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('respeta ORDER_FOOD del LLM aunque haya detectedProductName (regresión force post-LLM)', async () => {
    mockStructuredIntent({
      intent: 'ORDER_FOOD',
      confidence: 0.9,
      detectedProductName: 'tacu tacu',
      quantity: 1,
      quantityMode: null,
      addressText: null,
      addressConfidence: null,
      customerName: null,
      candidates: [
        { intent: 'ORDER_FOOD', confidence: 0.9 },
        { intent: 'PRODUCT_QUERY', confidence: 0.1 },
      ],
    });

    const result = await detectIntentWithConfidence(
      'Un tacu tacu',
      emptyDetectionContext
    );

    expect(result.intent).toBe(ConversationIntent.ORDER_FOOD);
    expect(result.detectedProductName).toBe('tacu tacu');
  });

  it('no fuerza PRODUCT_QUERY sobre UNKNOWN solo por mención de comida', async () => {
    mockStructuredIntent({
      intent: 'UNKNOWN',
      confidence: 0.9,
      detectedProductName: 'chicha',
      quantity: 1,
      quantityMode: null,
      addressText: null,
      addressConfidence: null,
      customerName: null,
      candidates: [
        { intent: 'MODIFY_QUANTITY', confidence: 0.1 },
        { intent: 'PRODUCT_QUERY', confidence: 0.1 },
      ],
    });

    const result = await detectIntentWithConfidence(
      'Una chicha',
      emptyDetectionContext
    );

    expect(result.intent).toBe(ConversationIntent.UNKNOWN);
  });
});
