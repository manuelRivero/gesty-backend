/**
 * suggest_dishes_for_party_size — filtro por raciones para mesa (RES-05).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();

vi.mock('../../lib/prisma', () => ({
  prisma: {
    menu_item: { findMany: (...args: unknown[]) => findMany(...args) },
  },
}));

vi.mock('../../services/menu.service', () => ({ MenuService: {} }));

vi.mock('../../repositories/conversationState.repository', () => ({
  patchConversationMetadata: vi.fn(),
  omitConversationMetadataKeys: vi.fn(),
  findOrCreateConversationState: vi.fn().mockResolvedValue({
    metadata: {
      reservation_agent_active: true,
      reservation_draft: { partySize: 6 },
      reservation_faq_delegation: {
        delegatedAt: new Date().toISOString(),
        reason: 'sugerir platos para 6 por raciones',
      },
    },
  }),
}));

import { suggestDishesForPartySizeTool } from '../index';
import { findOrCreateConversationState } from '../../repositories/conversationState.repository';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

describe('suggest_dishes_for_party_size', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prioriza serves_people exacto y devuelve shortlist', async () => {
    findMany.mockResolvedValue([
      {
        id: 'a',
        name: 'Parrillada 8',
        serves_people: 8,
        is_featured: false,
        variations: [],
        menu_category: { id: 'c1', name: 'Parrilla', category_tag: 'MAIN' },
        menu_item_price: [{ amount: 100, currency_code: 'ARS' }],
      },
      {
        id: 'b',
        name: 'Pollo a la brasa',
        serves_people: 6,
        is_featured: true,
        variations: [],
        menu_category: { id: 'c1', name: 'Parrilla', category_tag: 'MAIN' },
        menu_item_price: [{ amount: 50, currency_code: 'ARS' }],
      },
    ]);

    const raw = await suggestDishesForPartySizeTool.invoke(
      { partySize: 6, limit: 10 },
      CONFIG
    );
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    expect(result.success).toBe(true);
    expect(result.partySize).toBe(6);
    expect(result.items[0].name).toBe('Pollo a la brasa');
    expect(result.items[0].serves_people).toBe(6);
  });

  it('sin sesión de reserva pide delegar en vez de party size de pedido', async () => {
    vi.mocked(findOrCreateConversationState).mockResolvedValueOnce({
      metadata: {},
    } as never);

    const raw = await suggestDishesForPartySizeTool.invoke(
      { partySize: 6, limit: 10 },
      CONFIG
    );
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    expect(result.error).toBe('reservation_session_required');
    expect(result.instruction).toMatch(/start_reservation_session/);
    expect(result.instruction).toMatch(/6 personas/);
    expect(result.instruction).not.toMatch(/¿Para cuántas personas\?/);
    expect(findMany).not.toHaveBeenCalled();
  });
});
