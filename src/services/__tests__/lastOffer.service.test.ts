import { describe, it, expect } from 'vitest';
import {
  parseLastOffer,
  buildLastOfferContextLines,
  deriveConfirmOfferCandidate,
  getLastOffer,
} from '../lastOffer.service';
import { rankActiveIntent, buildIntentLedgerView } from '../intent/activeIntent.service';
import { getIntentCatalogEntry } from '../../domain/intent/family';

describe('lastOffer.service / CONFIRMAR_OFERTA (B.2)', () => {
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

  it('oferta fresca se inyecta (TTL leído)', () => {
    const now = Date.parse('2026-08-09T12:00:00.000Z');
    const lines = buildLastOfferContextLines(
      {
        intentLedger: {
          CONFIRMAR_OFERTA: {
            openedAt: '2026-08-09T11:50:00.000Z',
            surfaceCount: 0,
            productId: 'abc',
            productName: 'Ceviche',
            suggestedQuantity: 1,
            source: 'hybrid_cta',
          },
        },
      },
      now
    );
    expect(lines.some((l) => l.includes('Oferta activa'))).toBe(true);
    expect(lines.some((l) => l.includes('Hint NLP'))).toBe(false);
    expect(lines.some((l) => l.includes('add_cart_item'))).toBe(true);
    expect(lines.join('\n')).toMatch(/omití quantity/i);
    expect(lines.join('\n')).not.toMatch(/usá la sugerida/i);
  });

  it('oferta vencida → no se inyecta (V-12)', () => {
    const now = Date.parse('2026-08-09T12:00:00.000Z');
    const ttlMs = getIntentCatalogEntry('CONFIRMAR_OFERTA').ttlMs!;
    const openedAt = new Date(now - ttlMs - 1000).toISOString();
    const lines = buildLastOfferContextLines(
      {
        intentLedger: {
          CONFIRMAR_OFERTA: {
            openedAt,
            surfaceCount: 0,
            productId: 'abc',
            productName: 'Ceviche',
            suggestedQuantity: 1,
            source: 'hybrid_cta',
          },
        },
      },
      now
    );
    expect(lines.some((l) => l.includes('Oferta activa'))).toBe(false);
  });

  it('presupuesto 1 → segundo planteo en la misma vida no ocurre', () => {
    const now = Date.parse('2026-08-09T12:00:00.000Z');
    const meta = {
      intentLedger: {
        CONFIRMAR_OFERTA: {
          openedAt: '2026-08-09T11:50:00.000Z',
          surfaceCount: 1,
          lastSurfacedAt: '2026-08-09T11:51:00.000Z',
          productId: 'abc',
          productName: 'Ceviche',
          suggestedQuantity: 1,
          source: 'hybrid_cta',
        },
      },
    };
    expect(deriveConfirmOfferCandidate(meta, now)).toBeNull();

    const firstLife = {
      intentLedger: {
        CONFIRMAR_OFERTA: {
          openedAt: '2026-08-09T11:50:00.000Z',
          surfaceCount: 0,
          productId: 'abc',
          productName: 'Ceviche',
          suggestedQuantity: 1,
          source: 'hybrid_cta',
        },
      },
    };
    const candidate = deriveConfirmOfferCandidate(firstLife, now);
    expect(candidate?.type).toBe('CONFIRMAR_OFERTA');
    const ranked = rankActiveIntent(
      [candidate!],
      buildIntentLedgerView({
        extras: { CONFIRMAR_OFERTA: firstLife.intentLedger.CONFIRMAR_OFERTA },
      }),
      { now }
    );
    expect(ranked.active?.type).toBe('CONFIRMAR_OFERTA');
    expect(ranked.intentsPlanteadosPorTurno).toBe(1);
  });

  it('lee oferta desde Ledger (no bag paralelo)', () => {
    const offer = getLastOffer({
      intentLedger: {
        CONFIRMAR_OFERTA: {
          openedAt: '2026-08-09T11:50:00.000Z',
          productId: 'p1',
          productName: 'Lomo',
          suggestedQuantity: 2,
          source: 'product_focus',
        },
      },
    });
    expect(offer?.productName).toBe('Lomo');
    expect(offer?.suggestedQuantity).toBe(2);
  });
});
