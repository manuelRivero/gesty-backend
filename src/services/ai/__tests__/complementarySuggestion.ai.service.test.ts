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

  it('con IA y nextTag DESSERT → bundle con postre', async () => {
    vi.mocked(generateAIResponse).mockResolvedValue({
      content: JSON.stringify({
        skip: false,
        nextTag: 'DESSERT',
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

  it('sin IA → usa fallback del primer tag faltante con catálogo', async () => {
    const noAiBusiness = {
      id: 'biz-1',
      openai_active: false,
      ai_blocked: false,
    } as never;
    // MAIN+STARTER+SIDE cubiertos → primer faltante = DRINK
    vi.mocked(collectCategoryTagsInDraftCart).mockResolvedValue(
      new Set(['MAIN', 'STARTER', 'SIDE'])
    );

    const result = await buildComplementarySuggestionsWithLlm(noAiBusiness, {
      businessId: 'biz-1',
      draftOrderId: 'draft-1',
      lastAddedMenuItemId: 'main-1',
    });

    expect(generateAIResponse).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result!.items.map((i) => i.categoryTag)).toEqual(['DRINK']);
  });
});
