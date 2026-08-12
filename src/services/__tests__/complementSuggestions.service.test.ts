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

vi.mock('../intent/opportunities.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../intent/opportunities.service')>();
  return {
    ...actual,
    recordOpportunitySurfaced: vi.fn().mockResolvedValue(undefined),
  };
});

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
  buildAddItemShortcutsFollowUpList,
  buildComplementConfirmBodyIntro,
  buildComplementSuggestionsListMessage,
  canSurfaceComplementOpportunity,
  presentComplementSuggestionBundle,
  tryPresentComplementSuggestions,
} from '../complementSuggestions.service';

describe('canSurfaceComplementOpportunity', () => {
  it('true con ledger vacío', () => {
    expect(canSurfaceComplementOpportunity({})).toBe(true);
  });

  it('false tras 1ª ola sin engaged', () => {
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

  it('false si refused', () => {
    expect(
      canSurfaceComplementOpportunity({
        intentLedger: {
          SUGERIR_COMPLEMENTO: { refused: true, surfaceCount: 0 },
        },
      })
    ).toBe(false);
  });

  it('true si engaged y cooldown vencido', () => {
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    expect(
      canSurfaceComplementOpportunity({
        intentLedger: {
          SUGERIR_COMPLEMENTO: {
            surfaceCount: 1,
            engaged: true,
            lastSurfacedAt: old,
          },
        },
      })
    ).toBe(true);
  });
});

describe('buildAddItemShortcutsFollowUpList', () => {
  it('incluye fila ITEM_NOTE junto a gestión', () => {
    const list = buildAddItemShortcutsFollowUpList('Escribí: …');
    const rows = list.action.sections.flatMap((s) => s.rows);
    expect(rows.some((r) => r.id === 'ITEM_NOTE')).toBe(true);
    expect(rows.find((r) => r.id === 'ITEM_NOTE')?.title).toBe('Nota del pedido');
  });
});

describe('buildComplementSuggestionsListMessage', () => {
  it('incluye productos, filas de gestión y atajos tipables en el body', () => {
    const list = buildComplementSuggestionsListMessage({
      title: 'Algo dulce',
      titleEmoji: '🍰',
      bodyPlain: 'Si querés un postre, mirá estas opciones.',
      items: [
        { id: 'p1', name: 'Flan', categoryName: 'Postres' },
        { id: 'p2', name: 'Brownie', categoryName: 'Postres' },
      ],
      includeManagementRows: true,
    });

    const rows = list.action.sections.flatMap((s) => s.rows);
    expect(rows.some((r) => r.id === 'ADD_ITEM:p1')).toBe(true);
    expect(rows.some((r) => r.id === 'VIEW_CART')).toBe(true);
    expect(rows.some((r) => r.id === 'CHECKOUT')).toBe(true);
    expect(rows.some((r) => r.id === 'VIEW_CART_FOR_EDITION')).toBe(true);
    expect(rows.some((r) => r.id === 'ITEM_NOTE')).toBe(true);
    expect(rows.some((r) => r.id === 'VIEW_MENU')).toBe(true);
    expect(list.body.text).toMatch(/postre/i);
    expect(list.body.text).toContain('• *Flan*');
    expect(list.body.text).toContain('• *Brownie*');
    expect(list.body.text).toContain('• Ver *pedido*');
    expect(list.body.text).toContain('• *Modificar* pedido');
    expect(list.body.text).toContain('• *Finalizar* pedido');
    expect(list.body.text).toContain('• *Nota* del pedido');
    expect(list.body.text).toMatch(/gestión de tu pedido/i);
    // Footer WA ya invita a elegir/escribir; no repetir en el body.
    expect(list.body.text).not.toMatch(/O elegí de la lista/i);
    expect(list.body.text).not.toMatch(/Tocá el botón/i);
    // Sugerencias y gestión no van en un solo bloque continuo de viñetas.
    const body = list.body.text;
    const flanIdx = body.indexOf('• *Flan*');
    const mgmtIdx = body.search(/gestión de tu pedido/i);
    const verIdx = body.indexOf('• Ver *pedido*');
    const modIdx = body.indexOf('• *Modificar* pedido');
    expect(flanIdx).toBeGreaterThan(-1);
    expect(mgmtIdx).toBeGreaterThan(flanIdx);
    expect(verIdx).toBeGreaterThan(mgmtIdx);
    expect(modIdx).toBeGreaterThan(verIdx);
  });
});

describe('buildComplementConfirmBodyIntro', () => {
  it('pone la viñeta de envío bajo el total y antes del pitch', () => {
    const text = buildComplementConfirmBodyIntro({
      totalAmount: 12000,
      pitch: '¿Sumás una bebida?',
      shippingBullet:
        '• *Envío:* retiro en el local, sin cargo. Delivery según tu dirección; el monto se calcula al finalizar el pedido.',
    });
    expect(text).toMatch(/^Total hasta ahora: \$12[.\s]?000\./);
    expect(text).toContain('• *Envío:*');
    expect(text.indexOf('• *Envío:*')).toBeLessThan(text.indexOf('¿Sumás una bebida?'));
  });
});

describe('presentComplementSuggestionBundle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registra SUGERIR_COMPLEMENTO y deja selección pendiente tipable', async () => {
    const { patchConversationMetadata } = await import('../../repositories');
    const productId = '33333333-3333-3333-3333-333333333333';
    const list = await presentComplementSuggestionBundle({
      conversationId: 'conv-1',
      metadata: {},
      confirm: {
        itemName: 'Milanesa',
        quantity: 1,
        totalAmount: 80000,
      },
      shippingBullet:
        '• *Envío:* a tu dirección, $800. El retiro en el local es sin cargo.',
      bundle: {
        snapshot: {
          v: 1,
          draftOrderId: '11111111-1111-1111-1111-111111111111',
          businessId: '22222222-2222-2222-2222-222222222222',
          orderedItemIds: [productId],
          pitchBody: 'Probá un postre.',
          title: 'Algo dulce',
          titleEmoji: '🍰',
          createdAtIso: new Date().toISOString(),
        },
        bridgeMessagePlain: 'Ya sumaste la milanesa. ¿Un postre?',
        items: [{ id: productId, name: 'Flan', categoryName: 'Postres' }],
      },
    });

    expect(list).not.toBeNull();
    expect(list!.body.text).toMatch(/¡Listo! Sumé Milanesa al pedido/i);
    expect(list!.body.text).toMatch(/Total hasta ahora/i);
    expect(list!.body.text).toContain('• *Envío:* a tu dirección, $800');
    expect(list!.body.text).toContain('Probá un postre.');
    expect(list!.body.text).not.toMatch(/Ya sumaste la milanesa/i);
    expect(list!.body.text).not.toMatch(/O elegí de la lista/i);
    expect(list!.body.text).toContain('• *Flan*');
    expect(recordOpportunitySurfaced).toHaveBeenCalledWith(
      'conv-1',
      'SUGERIR_COMPLEMENTO',
      expect.anything(),
      { offeredProductIds: [productId] }
    );
    expect(patchConversationMetadata).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        pendingProductSelection: true,
        candidateProductIds: [productId],
        pendingTipables: expect.objectContaining({
          management: expect.arrayContaining([
            'VIEW_MENU',
            'VIEW_CART',
            'ITEM_NOTE',
            'CHECKOUT',
          ]),
        }),
      })
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
