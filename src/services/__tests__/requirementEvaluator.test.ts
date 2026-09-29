import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  conversationFindUniqueMock,
  resolveProductForAddMock,
  partySizeMissingMock,
} = vi.hoisted(() => ({
  conversationFindUniqueMock: vi.fn(),
  resolveProductForAddMock: vi.fn(),
  partySizeMissingMock: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  prisma: {
    conversation_state: { findUnique: conversationFindUniqueMock },
  },
}));

vi.mock('../productResolution.service', () => ({
  resolveProductForAdd: resolveProductForAddMock,
}));

vi.mock('../pendingAddQuantity.service', () => ({
  getPendingAddQuantity: vi.fn(() => null),
}));

vi.mock('../pendingVariation.service', () => ({
  getPendingVariation: vi.fn(() => null),
}));

vi.mock('../partySizeGoal.service', () => ({
  isPartySizeMissingForOrderingTools: partySizeMissingMock,
}));

import { evaluateToolRequirement } from '../requirementEvaluator';

const PRODUCT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PEDIR = {
  id: 'intent-order',
  sequence: 1,
  goal: 'PEDIR',
  request: { products: ['ceviche'] },
  status: 'ACTIVE',
  blockers: [],
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
};
const params = (overrides: Record<string, unknown> = {}) => ({
  toolName: 'add_cart_item',
  callArgs: { productId: PRODUCT_ID },
  businessId: 'biz-1',
  conversationId: 'conv-1',
  humanIntent: PEDIR,
  ...overrides,
});

describe('evaluateToolRequirement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conversationFindUniqueMock.mockResolvedValue({ metadata: {} });
    resolveProductForAddMock.mockResolvedValue({
      ok: true,
      resolution: { productId: PRODUCT_ID, resolutionId: 'resolution-1' },
    });
    partySizeMissingMock.mockReturnValue(false);
  });

  it('devuelve DEFER cuando ProductResolution no es válida', async () => {
    resolveProductForAddMock.mockResolvedValue({ ok: false, reason: 'resolution_missing' });

    await expect(evaluateToolRequirement(params())).resolves.toMatchObject({
      type: 'DEFER',
      reason: 'resolution_missing',
      missingRequirements: ['PRODUCT_RESOLVED'],
    });
    expect(partySizeMissingMock).not.toHaveBeenCalled();
  });

  it('devuelve DEFER por party size después de validar ProductResolution', async () => {
    partySizeMissingMock.mockReturnValue(true);

    await expect(evaluateToolRequirement(params())).resolves.toMatchObject({
      type: 'DEFER',
      reason: 'party_size_required',
      missingRequirements: ['PARTY_SIZE_OBTAINED'],
    });
    expect(resolveProductForAddMock).toHaveBeenCalledOnce();
  });

  it('devuelve ALLOW con resolución válida y party size permitido', async () => {
    await expect(evaluateToolRequirement(params())).resolves.toEqual({ type: 'ALLOW' });
  });

  it('devuelve REJECT para ADD incompatible con HumanIntent', async () => {
    await expect(
      evaluateToolRequirement(params({ humanIntent: { ...PEDIR, goal: 'EXPLORAR' } }))
    ).resolves.toMatchObject({
      type: 'REJECT',
      reason: 'human_intent_incompatible',
    });
    expect(resolveProductForAddMock).not.toHaveBeenCalled();
  });

  it('reutiliza la resolución ya validada en el batch sin volver a resolver', async () => {
    await expect(
      evaluateToolRequirement(params({
        validatedProductResolution: { productId: PRODUCT_ID, resolutionId: 'resolution-1' },
      }))
    ).resolves.toEqual({ type: 'ALLOW' });
    expect(resolveProductForAddMock).not.toHaveBeenCalled();
  });
});
