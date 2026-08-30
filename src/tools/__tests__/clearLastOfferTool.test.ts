/**
 * Tool clear_last_offer (PR2): invalidación ReAct del Fact de oferta.
 * Efecto = clearLastOffer; no toca carrito ni tipables.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {},
}));

vi.mock('../../services/menu.service', () => ({
  MenuService: {},
}));

vi.mock('../../services/lastOffer.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/lastOffer.service')>();
  return {
    ...actual,
    clearLastOffer: vi.fn().mockResolvedValue(undefined),
  };
});

import { clearLastOfferTool, allReactTools } from '../index';
import { clearLastOffer } from '../../services/lastOffer.service';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-clear-offer',
    conversationStartedAt: new Date().toISOString(),
  },
};

describe('clear_last_offer tool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('está registrada en allReactTools', () => {
    expect(allReactTools.map((t) => t.name)).toContain('clear_last_offer');
  });

  it('llama clearLastOffer y devuelve cleared: true', async () => {
    const raw = await clearLastOfferTool.func({}, undefined, CONFIG);
    expect(clearLastOffer).toHaveBeenCalledWith('conv-clear-offer');
    expect(JSON.parse(raw)).toEqual({ cleared: true });
  });
});
