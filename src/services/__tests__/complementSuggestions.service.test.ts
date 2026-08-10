import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key-for-vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    menu_item: { findMany: vi.fn() },
    draft_order: { findFirst: vi.fn() },
  },
}));

vi.mock('../../repositories', () => ({
  createConversationMessage: vi.fn().mockResolvedValue(undefined),
  omitConversationMetadataKeys: vi.fn().mockResolvedValue(undefined),
  patchConversationMetadata: vi.fn().mockResolvedValue(undefined),
  updateConversationLastMessageAt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../intent/opportunities.service', () => ({
  recordOpportunitySurfaced: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../ai/complementarySuggestion.ai.service', () => ({
  buildComplementarySuggestionsWithLlm: vi.fn(),
}));

vi.mock('../ai/openai.service', () => ({
  generateAIResponse: vi.fn(),
}));

vi.mock('../productQuery', () => ({
  formatBotUserMessage: (title: string, emoji: string, body: string) =>
    `${emoji} ${title}\n${body}`,
}));

import { recordOpportunitySurfaced } from '../intent/opportunities.service';
import { buildComplementarySuggestionsWithLlm } from '../ai/complementarySuggestion.ai.service';
import {
  buildComplementSuggestionsListMessage,
  canSurfaceComplementOpportunity,
  presentComplementSuggestionBundle,
  tryPresentComplementSuggestions,
} from '../complementSuggestions.service';

describe('canSurfaceComplementOpportunity', () => {
  it('true con ledger vacío', () => {
    expect(canSurfaceComplementOpportunity({})).toBe(true);
  });

  it('false si surfaceCount >= 1', () => {
    expect(
      canSurfaceComplementOpportunity({
        intentLedger: {
          SUGERIR_COMPLEMENTO: {
            surfaceCount: 1,
            lastSurfacedAt: new Date().toISOString(),
          },
        },
      })
    ).toBe(false);
  });
});

describe('buildComplementSuggestionsListMessage', () => {
  it('incluye productos y filas de gestión cuando se pide', () => {
    const list = buildComplementSuggestionsListMessage({
      title: 'Algo dulce',
      titleEmoji: '🍰',
      bodyPlain: 'Si querés un postre, mirá la lista.',
      items: [
        { id: 'p1', name: 'Flan', categoryName: 'Postres' },
        { id: 'p2', name: 'Brownie', categoryName: 'Postres' },
      ],
      includeManagementRows: true,
    });

    const rows = list.action.sections.flatMap((s) => s.rows);
    expect(rows.some((r) => r.id === 'ADD_ITEM:p1:1')).toBe(true);
    expect(rows.some((r) => r.id === 'CHECKOUT')).toBe(true);
    expect(rows.some((r) => r.id === 'VIEW_CART_FOR_EDITION')).toBe(true);
    expect(rows.some((r) => r.id === 'VIEW_MENU')).toBe(true);
    expect(list.body.text).toMatch(/postre/i);
  });
});

describe('presentComplementSuggestionBundle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registra SUGERIR_COMPLEMENTO en el ledger', async () => {
    const list = await presentComplementSuggestionBundle({
      conversationId: 'conv-1',
      metadata: {},
      bundle: {
        snapshot: {
          v: 1,
          draftOrderId: '11111111-1111-1111-1111-111111111111',
          businessId: '22222222-2222-2222-2222-222222222222',
          orderedItemIds: ['33333333-3333-3333-3333-333333333333'],
          pitchBody: 'Probá un postre.',
          title: 'Algo dulce',
          titleEmoji: '🍰',
          createdAtIso: new Date().toISOString(),
        },
        bridgeMessagePlain: 'Ya sumaste la milanesa. ¿Un postre?',
        items: [{ id: '33333333-3333-3333-3333-333333333333', name: 'Flan', categoryName: 'Postres' }],
      },
    });

    expect(list).not.toBeNull();
    expect(recordOpportunitySurfaced).toHaveBeenCalledWith(
      'conv-1',
      'SUGERIR_COMPLEMENTO',
      expect.anything()
    );
  });
});

describe('tryPresentComplementSuggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('null si el presupuesto de la Opportunity ya se gastó', async () => {
    const result = await tryPresentComplementSuggestions({
      business: { id: 'biz-1' } as never,
      conversationId: 'conv-1',
      metadata: {
        intentLedger: {
          SUGERIR_COMPLEMENTO: { surfaceCount: 1, lastSurfacedAt: new Date().toISOString() },
        },
      },
      draftOrderId: 'draft-1',
      lastAddedMenuItemId: 'item-1',
    });

    expect(result).toBeNull();
    expect(buildComplementarySuggestionsWithLlm).not.toHaveBeenCalled();
  });

  it('null si el builder hace skip', async () => {
    vi.mocked(buildComplementarySuggestionsWithLlm).mockResolvedValue(null);

    const result = await tryPresentComplementSuggestions({
      business: { id: 'biz-1' } as never,
      conversationId: 'conv-1',
      metadata: {},
      draftOrderId: 'draft-1',
      lastAddedMenuItemId: 'item-1',
    });

    expect(result).toBeNull();
  });
});
