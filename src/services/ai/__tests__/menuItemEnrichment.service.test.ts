/**
 * PLAN-ACCION-SHOPPING-ONLY.md — `generateMenuItemEnrichment` es exclusivamente
 * IA (no hay versión determinista equivalente): debe rechazar con
 * `AI_CAPABILITY_DENIED` para un negocio sin IA habilitada, sin llamar a OpenAI.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockedCreate } = vi.hoisted(() => ({ mockedCreate: vi.fn() }));

vi.mock('openai', () => ({
  default: function MockOpenAI() {
    return { chat: { completions: { create: mockedCreate } } };
  },
}));

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    menu_item: { findUnique: vi.fn() },
  },
}));

vi.mock('../../billing/businessCapabilities.service', () => ({
  resolveBusinessCapabilities: vi.fn(),
}));

import { prisma } from '../../../lib/prisma';
import { resolveBusinessCapabilities } from '../../billing/businessCapabilities.service';
import { generateMenuItemEnrichment } from '../menuItemEnrichment.service';

const mockedFindUnique = prisma.menu_item.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedResolveCapabilities = resolveBusinessCapabilities as unknown as ReturnType<
  typeof vi.fn
>;

const MENU_ITEM_ID = 'item-1';

function fullMenuItem(overrides: Record<string, unknown> = {}) {
  return {
    id: MENU_ITEM_ID,
    business_id: 'biz-1',
    name: 'Muzzarella',
    description: null,
    ingredients: null,
    preparation: null,
    menu_category: { name: 'Pizzas', category_tag: 'MAIN' },
    menu_item_price: [],
    ...overrides,
  };
}

const validDraft = {
  display_name: 'Muzza Clásica',
  short_description: 'La de siempre',
  search_keywords: ['pizza', 'muzza'],
  synonyms: ['muzzarella'],
  category_suggestion: 'Plato fuerte',
  product_tags: ['vegetariano'],
};

function chatResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

describe('generateMenuItemEnrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rechaza con AI_CAPABILITY_DENIED y no llama a OpenAI si el negocio no tiene IA habilitada', async () => {
    mockedFindUnique.mockResolvedValueOnce(fullMenuItem());
    mockedResolveCapabilities.mockResolvedValueOnce({
      ai: { allowed: false, reason: 'plan_ai_disabled' },
      shopping: { allowed: true, reason: 'ok' },
    });

    await expect(generateMenuItemEnrichment(MENU_ITEM_ID)).rejects.toThrow(
      'AI_CAPABILITY_DENIED'
    );
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('lanza MENU_ITEM_NOT_FOUND sin consultar capacidades si el producto no existe', async () => {
    mockedFindUnique.mockResolvedValueOnce(null);

    await expect(generateMenuItemEnrichment('ghost')).rejects.toThrow('MENU_ITEM_NOT_FOUND');
    expect(mockedResolveCapabilities).not.toHaveBeenCalled();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('genera el borrador cuando el negocio sí tiene IA habilitada', async () => {
    mockedFindUnique.mockResolvedValueOnce(fullMenuItem());
    mockedResolveCapabilities.mockResolvedValueOnce({
      ai: { allowed: true, reason: 'ok' },
      shopping: { allowed: true, reason: 'ok' },
    });
    mockedCreate.mockResolvedValueOnce(chatResponse(JSON.stringify(validDraft)));

    const draft = await generateMenuItemEnrichment(MENU_ITEM_ID);
    expect(draft).toEqual(validDraft);
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });
});
