import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuCategoryTag } from '@prisma/client';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    menu_item: { findFirst: vi.fn(), findMany: vi.fn() },
    draft_order_item: { findMany: vi.fn() },
  },
}));

vi.mock('../openai.service', () => ({
  generateAIResponse: vi.fn(),
}));

vi.mock('../../botPersonality.service', () => ({
  resolvePersonalityForBusiness: vi.fn().mockResolvedValue({ promptText: 'PERSONA' }),
}));

vi.mock('../../../helpers/complementaryMenu.helper', async () => {
  const actual = await vi.importActual<typeof import('../../../helpers/complementaryMenu.helper')>(
    '../../../helpers/complementaryMenu.helper'
  );
  return {
    ...actual,
    getMenuItemCategoryTag: vi.fn(),
    collectCategoryTagsInDraftCart: vi.fn(),
    fetchComplementaryMenuItems: vi.fn(),
  };
});

import { prisma } from '../../../lib/prisma';
import { generateAIResponse } from '../openai.service';
import {
  collectCategoryTagsInDraftCart,
  fetchComplementaryMenuItems,
  getMenuItemCategoryTag,
} from '../../../helpers/complementaryMenu.helper';
import { buildComplementarySuggestionsWithLlm } from '../complementarySuggestion.ai.service';

const DRINK_ID = '11111111-1111-1111-1111-111111111111';
const DESSERT_ID = '22222222-2222-2222-2222-222222222222';

const business = {
  id: 'biz-1',
  openai_active: true,
  ai_blocked: false,
} as never;

function catalogDrinkDessert() {
  return [
    {
      id: DRINK_ID,
      name: 'Limonada',
      categoryTag: 'DRINK' as MenuCategoryTag,
      categoryName: 'Bebidas',
    },
    {
      id: DESSERT_ID,
      name: 'Flan',
      categoryTag: 'DESSERT' as MenuCategoryTag,
      categoryName: 'Postres',
    },
  ];
}

describe('buildComplementarySuggestionsWithLlm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getMenuItemCategoryTag).mockResolvedValue('MAIN');
    vi.mocked(collectCategoryTagsInDraftCart).mockResolvedValue(new Set(['MAIN']));
    vi.mocked(prisma.menu_item.findFirst).mockResolvedValue({ name: 'Milanesa' } as never);
    vi.mocked(prisma.draft_order_item.findMany).mockResolvedValue([
      {
        product_id: 'main-1',
        menu_item: {
          name: 'Milanesa',
          menu_category: { category_tag: 'MAIN', is_active: true },
        },
      },
    ] as never);
    vi.mocked(fetchComplementaryMenuItems).mockImplementation(async ({ tags }) =>
      catalogDrinkDessert().filter((i) => tags.includes(i.categoryTag))
    );
  });

  it('con IA y skip → null (no fuerza fallback)', async () => {
    vi.mocked(generateAIResponse).mockResolvedValue({
      content: JSON.stringify({ skip: true, reason: 'cliente apurado' }),
    } as never);

    const result = await buildComplementarySuggestionsWithLlm(business, {
      businessId: 'biz-1',
      draftOrderId: 'draft-1',
      lastAddedMenuItemId: 'main-1',
    });

    expect(result).toBeNull();
  });

  it('con IA y nextTags DESSERT → bundle con postre', async () => {
    vi.mocked(generateAIResponse).mockResolvedValue({
      content: JSON.stringify({
        skip: false,
        nextTags: ['DESSERT'],
        pitch: 'Si querés algo dulce para cerrar, mirá estas opciones.',
        bridgeMessage:
          '¡Genial! Ya sumaste *Milanesa*. Si querés, tengo postres que van muy bien.',
        orderedIds: [DESSERT_ID],
      }),
    } as never);

    const result = await buildComplementarySuggestionsWithLlm(business, {
      businessId: 'biz-1',
      draftOrderId: 'draft-1',
      lastAddedMenuItemId: 'main-1',
    });

    expect(result).not.toBeNull();
    expect(result!.snapshot.title).toMatch(/dulce|postre/i);
    expect(result!.items.map((i) => i.id)).toEqual([DESSERT_ID]);
    expect(result!.bridgeMessagePlain).toMatch(/Milanesa/);
  });

  it('con IA y nextTags DRINK+DESSERT → hasta 2 categorías en la lista', async () => {
    vi.mocked(generateAIResponse).mockResolvedValue({
      content: JSON.stringify({
        skip: false,
        nextTags: ['DRINK', 'DESSERT'],
        pitch: 'Podés sumar bebida o algo dulce.',
        bridgeMessage:
          '¡Genial! Ya sumaste *Milanesa*. Si querés, mirá bebidas y postres que van muy bien.',
        orderedIds: [DRINK_ID, DESSERT_ID],
      }),
    } as never);

    const result = await buildComplementarySuggestionsWithLlm(business, {
      businessId: 'biz-1',
      draftOrderId: 'draft-1',
      lastAddedMenuItemId: 'main-1',
    });

    expect(result).not.toBeNull();
    const tags = new Set(result!.items.map((i) => i.categoryTag));
    expect(tags.has('DRINK')).toBe(true);
    expect(tags.has('DESSERT')).toBe(true);
  });

  it('compat: nextTag legacy único sigue funcionando', async () => {
    vi.mocked(generateAIResponse).mockResolvedValue({
      content: JSON.stringify({
        skip: false,
        nextTag: 'DRINK',
        pitch: 'Una bebida fresca queda genial con tu plato.',
        bridgeMessage:
          '¡Genial! Ya sumaste *Milanesa*. Si querés, tengo bebidas que van muy bien.',
        orderedIds: [DRINK_ID],
      }),
    } as never);

    const result = await buildComplementarySuggestionsWithLlm(business, {
      businessId: 'biz-1',
      draftOrderId: 'draft-1',
      lastAddedMenuItemId: 'main-1',
    });

    expect(result!.items.map((i) => i.categoryTag)).toEqual(['DRINK']);
  });

  it('sin IA → fallback de hasta 2 tags faltantes (STARTER+DRINK si solo MAIN)', async () => {
    const noAiBusiness = {
      id: 'biz-1',
      openai_active: false,
      ai_blocked: false,
    } as never;
    vi.mocked(collectCategoryTagsInDraftCart).mockResolvedValue(new Set(['MAIN']));

    const starterId = '44444444-4444-4444-4444-444444444444';
    vi.mocked(fetchComplementaryMenuItems).mockImplementation(async ({ tags }) => {
      const all = [
        ...catalogDrinkDessert(),
        {
          id: starterId,
          name: 'Empanada',
          categoryTag: 'STARTER' as MenuCategoryTag,
          categoryName: 'Entradas',
        },
      ];
      return all.filter((i) => tags.includes(i.categoryTag));
    });

    const result = await buildComplementarySuggestionsWithLlm(noAiBusiness, {
      businessId: 'biz-1',
      draftOrderId: 'draft-1',
      lastAddedMenuItemId: 'main-1',
    });

    expect(generateAIResponse).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    const tags = new Set(result!.items.map((i) => i.categoryTag));
    // Orden MENU_COMPLETE: STARTER, MAIN, DRINK, DESSERT → faltan STARTER+DRINK primero
    expect(tags.has('STARTER')).toBe(true);
    expect(tags.has('DRINK')).toBe(true);
  });

  it('solo postre en carrito → puede ofrecer hacia MAIN/entrada', async () => {
    vi.mocked(collectCategoryTagsInDraftCart).mockResolvedValue(new Set(['DESSERT']));
    vi.mocked(getMenuItemCategoryTag).mockResolvedValue('DESSERT');
    const mainId = '55555555-5555-5555-5555-555555555555';
    vi.mocked(fetchComplementaryMenuItems).mockResolvedValue([
      {
        id: mainId,
        name: 'Bife',
        categoryTag: 'MAIN',
        categoryName: 'Principales',
      },
    ]);

    const noAiBusiness = {
      id: 'biz-1',
      openai_active: false,
      ai_blocked: false,
    } as never;

    const result = await buildComplementarySuggestionsWithLlm(noAiBusiness, {
      businessId: 'biz-1',
      draftOrderId: 'draft-1',
      lastAddedMenuItemId: 'dessert-1',
    });

    expect(result).not.toBeNull();
    expect(result!.items.some((i) => i.categoryTag === 'MAIN')).toBe(true);
  });
});
