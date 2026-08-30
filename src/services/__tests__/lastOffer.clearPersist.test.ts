import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../repositories', () => ({
  omitConversationMetadataKeys: vi.fn().mockResolvedValue(undefined),
  setLastReferencedProductId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../intentLedger.repository', () => ({
  patchIntentLedgerEntry: vi.fn().mockResolvedValue(undefined),
}));

import { clearLastOffer, persistLastOffer } from '../lastOffer.service';
import { omitConversationMetadataKeys, setLastReferencedProductId } from '../../repositories';
import { patchIntentLedgerEntry } from '../intentLedger.repository';

describe('lastOffer clear / persist (PR2 writes)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('clearLastOffer vacía el ledger CONFIRMAR_OFERTA y omite bag legacy', async () => {
    await clearLastOffer('conv-1');
    expect(patchIntentLedgerEntry).toHaveBeenCalledWith('conv-1', 'CONFIRMAR_OFERTA', {});
    expect(omitConversationMetadataKeys).toHaveBeenCalledWith('conv-1', ['lastOffer']);
  });

  it('persistLastOffer(Y) escribe Y con surfaceCount 0 (reemplazo)', async () => {
    await persistLastOffer({
      conversationId: 'conv-1',
      productId: 'product-y',
      productName: 'Hamburguesa',
      suggestedQuantity: 1,
      source: 'product_query',
    });
    expect(patchIntentLedgerEntry).toHaveBeenCalledWith(
      'conv-1',
      'CONFIRMAR_OFERTA',
      expect.objectContaining({
        productId: 'product-y',
        productName: 'Hamburguesa',
        surfaceCount: 0,
        source: 'product_query',
      })
    );
    expect(setLastReferencedProductId).toHaveBeenCalledWith('conv-1', 'product-y');
    expect(omitConversationMetadataKeys).toHaveBeenCalledWith('conv-1', ['lastOffer']);
  });
});
