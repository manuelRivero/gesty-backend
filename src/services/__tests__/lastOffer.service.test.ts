import { describe, it, expect } from 'vitest';
import {
  parseLastOffer,
  buildLastOfferContextLines,
} from '../lastOffer.service';

describe('lastOffer.service', () => {
  it('parseLastOffer acepta payload válido', () => {
    const offer = parseLastOffer({
      kind: 'ADD_ITEM',
      productId: '3c3118fd-f884-4eca-a216-381354dd9e2c',
      productName: 'Ceviche Clásico',
      suggestedQuantity: 1,
      offeredAt: '2026-07-04T00:00:00.000Z',
      source: 'hybrid_cta',
    });
    expect(offer?.productName).toBe('Ceviche Clásico');
    expect(offer?.suggestedQuantity).toBe(1);
  });

  it('buildLastOfferContextLines incluye oferta y hint NLP', () => {
    const lines = buildLastOfferContextLines(
      {
        lastOffer: {
          kind: 'ADD_ITEM',
          productId: 'abc',
          productName: 'Ceviche',
          suggestedQuantity: 1,
          offeredAt: '2026-07-04T00:00:00.000Z',
          source: 'hybrid_cta',
        },
      },
      {
        intent: 'PRODUCT_QUERY',
        detectedProductName: 'Ceviche clásico',
        quantity: 1,
      }
    );
    expect(lines.some((l) => l.includes('Oferta activa'))).toBe(true);
    expect(lines.some((l) => l.includes('Hint NLP'))).toBe(true);
    expect(lines.some((l) => l.includes('add_cart_item'))).toBe(true);
  });
});
