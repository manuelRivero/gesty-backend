import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/llm', () => ({
  getIntentDetectorLlm: vi.fn(),
}));

import {
  detectIntentWithConfidence,
  shouldAskIntentConfirmation,
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

describe('shouldAskIntentConfirmation — Opción D', () => {
  it('NO pregunta cuando la decisión es direct con confianza alta (caso del log: RECOMMENDATION_REQUEST 0.85)', () => {
    const detection = baseDetection({
      intent: ConversationIntent.RECOMMENDATION_REQUEST,
      confidence: 0.85,
      candidates: [
        { intent: ConversationIntent.RECOMMENDATION_REQUEST, confidence: 0.85 },
        { intent: ConversationIntent.VIEW_MENU, confidence: 0.15 },
      ],
      alternatives: [{ intent: ConversationIntent.VIEW_MENU, confidence: 0.15 }],
      resolutionSource: 'direct',
      topCandidate: {
        intent: ConversationIntent.RECOMMENDATION_REQUEST,
        confidence: 0.85,
      },
      rescueMargin: 0.7,
    });

    expect(shouldAskIntentConfirmation(detection)).toBe(false);
  });

  it('NO pregunta cuando es direct y rescueMargin chico (alternativa cercana pero la decisión es firme)', () => {
    const detection = baseDetection({
      intent: ConversationIntent.PRODUCT_QUERY,
      confidence: 0.6,
      candidates: [
        { intent: ConversationIntent.PRODUCT_QUERY, confidence: 0.6 },
        { intent: ConversationIntent.RECOMMENDATION_REQUEST, confidence: 0.55 },
      ],
      alternatives: [
        { intent: ConversationIntent.RECOMMENDATION_REQUEST, confidence: 0.55 },
      ],
      resolutionSource: 'direct',
      topCandidate: { intent: ConversationIntent.PRODUCT_QUERY, confidence: 0.6 },
      rescueMargin: 0.05,
    });

    expect(shouldAskIntentConfirmation(detection)).toBe(false);
  });

  it('NO pregunta cuando el resultado fue rescued', () => {
    const detection = baseDetection({
      intent: ConversationIntent.ORDER_FOOD,
      confidence: 0.5,
      candidates: [
        { intent: ConversationIntent.ORDER_FOOD, confidence: 0.5 },
        { intent: ConversationIntent.SMALL_TALK, confidence: 0.2 },
      ],
      alternatives: [{ intent: ConversationIntent.SMALL_TALK, confidence: 0.2 }],
      resolutionSource: 'rescued',
      topCandidate: { intent: ConversationIntent.ORDER_FOOD, confidence: 0.5 },
      rescueMargin: 0.3,
    });

    expect(shouldAskIntentConfirmation(detection)).toBe(false);
  });

  it('SÍ pregunta cuando uncertain con margen chico y hay alternativa', () => {
    const detection = baseDetection({
      intent: ConversationIntent.PRODUCT_QUERY,
      confidence: 0.4,
      candidates: [
        { intent: ConversationIntent.PRODUCT_QUERY, confidence: 0.4 },
        { intent: ConversationIntent.VIEW_MENU, confidence: 0.35 },
      ],
      alternatives: [{ intent: ConversationIntent.VIEW_MENU, confidence: 0.35 }],
      resolutionSource: 'uncertain',
      topCandidate: { intent: ConversationIntent.PRODUCT_QUERY, confidence: 0.4 },
      rescueMargin: 0.05,
    });

    expect(shouldAskIntentConfirmation(detection)).toBe(true);
  });

  it('NO pregunta cuando uncertain pero el margen supera MIN_MARGIN', () => {
    const detection = baseDetection({
      intent: ConversationIntent.PRODUCT_QUERY,
      confidence: 0.5,
      candidates: [
        { intent: ConversationIntent.PRODUCT_QUERY, confidence: 0.5 },
        { intent: ConversationIntent.VIEW_MENU, confidence: 0.2 },
      ],
      alternatives: [{ intent: ConversationIntent.VIEW_MENU, confidence: 0.2 }],
      resolutionSource: 'uncertain',
      topCandidate: { intent: ConversationIntent.PRODUCT_QUERY, confidence: 0.5 },
      rescueMargin: 0.3,
    });

    expect(detection.rescueMargin! >= MIN_MARGIN).toBe(true);
    expect(shouldAskIntentConfirmation(detection)).toBe(false);
  });

  it('NO pregunta cuando uncertain pero no hay alternatives', () => {
    const detection = baseDetection({
      intent: ConversationIntent.PRODUCT_QUERY,
      confidence: 0.4,
      candidates: [
        { intent: ConversationIntent.PRODUCT_QUERY, confidence: 0.4 },
      ],
      alternatives: [],
      resolutionSource: 'uncertain',
      topCandidate: { intent: ConversationIntent.PRODUCT_QUERY, confidence: 0.4 },
      rescueMargin: null,
    });

    expect(shouldAskIntentConfirmation(detection)).toBe(false);
  });

  it('NO pregunta cuando source=unknown (fallback duro)', () => {
    const detection = baseDetection({
      resolutionSource: 'unknown',
      candidates: [
        { intent: ConversationIntent.SMALL_TALK, confidence: 0.3 },
        { intent: ConversationIntent.VIEW_MENU, confidence: 0.25 },
      ],
      alternatives: [
        { intent: ConversationIntent.SMALL_TALK, confidence: 0.3 },
        { intent: ConversationIntent.VIEW_MENU, confidence: 0.25 },
      ],
    });

    expect(shouldAskIntentConfirmation(detection)).toBe(false);
  });
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
