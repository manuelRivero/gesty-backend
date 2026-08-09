import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MenuCategoryTag } from '@prisma/client';
import {
  deriveSuggestComplementCandidate,
  deriveSuggestAddressCandidate,
  deriveCollectPartySizeCandidate,
} from '../opportunities.service';
import {
  buildIntentLedgerView,
  deriveIntentCandidates,
  rankActiveIntent,
} from '../activeIntent.service';

const tags = (...t: MenuCategoryTag[]) => new Set<MenuCategoryTag>(t);

describe('SUGERIR_COMPLEMENTO (C.1)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => logSpy.mockRestore());

  it('con Goal COMPLETAR_PEDIDO con permiso → Opportunity suprimida', () => {
    const opportunity = deriveSuggestComplementCandidate(
      { cartTags: tags('MAIN'), checkoutActive: false },
      { surfaceCount: 0 }
    );
    expect(opportunity).not.toBeNull();

    const candidates = deriveIntentCandidates({
      order: {
        facts: { hasItems: true, checkoutActive: false },
        ledger: { abandonment: false, surfaceCount: 0, lastSurfacedAt: null },
      },
      reservation: {
        facts: { hasDraft: false, reservationAgentActive: false },
        ledger: { abandonment: false, surfaceCount: 0, lastSurfacedAt: null },
        hasEnvironments: false,
      },
      extras: [opportunity!],
    });
    const ranked = rankActiveIntent(
      candidates,
      buildIntentLedgerView({
        order: { abandonment: false, surfaceCount: 0, lastSurfacedAt: null },
        extras: { SUGERIR_COMPLEMENTO: { surfaceCount: 0 } },
      })
    );
    expect(ranked.active?.type).toBe('COMPLETAR_PEDIDO');
    expect(ranked.suppressed.map((c) => c.type)).toContain('SUGERIR_COMPLEMENTO');
    expect(ranked.intentsPlanteadosPorTurno).toBe(1);
  });

  it('sin Goals abiertos, principal sin bebida → Opportunity activa una vez', () => {
    const opportunity = deriveSuggestComplementCandidate(
      { cartTags: tags('MAIN'), checkoutActive: false },
      { surfaceCount: 0 }
    );
    const ranked = rankActiveIntent(
      [opportunity!],
      { SUGERIR_COMPLEMENTO: { surfaceCount: 0 } }
    );
    expect(ranked.active?.type).toBe('SUGERIR_COMPLEMENTO');
  });

  it('segundo turno de la misma vida → no se replantea (presupuesto 1)', () => {
    expect(
      deriveSuggestComplementCandidate(
        { cartTags: tags('MAIN'), checkoutActive: false },
        { surfaceCount: 1, lastSurfacedAt: new Date().toISOString() }
      )
    ).toBeNull();
  });
});

describe('SUGERIR_DIRECCION (C.2)', () => {
  it('con OBTENER_DIRECCION bloqueante (checkout) → no aparece', () => {
    expect(
      deriveSuggestAddressCandidate(
        { hasAddress: false, blockingAddressIntent: true },
        { surfaceCount: 0 }
      )
    ).toBeNull();
  });

  it('conversacional, sin dirección, sin checkout → aparece como máximo 1 vez', () => {
    const c = deriveSuggestAddressCandidate(
      { hasAddress: false, blockingAddressIntent: false },
      { surfaceCount: 0 }
    );
    expect(c?.type).toBe('SUGERIR_DIRECCION');
    expect(
      deriveSuggestAddressCandidate(
        { hasAddress: false, blockingAddressIntent: false },
        { surfaceCount: 1 }
      )
    ).toBeNull();
  });
});

describe('RECOLECTAR_PARTY_SIZE (C.3)', () => {
  it('presupuesto 1 verificado', () => {
    const open = deriveCollectPartySizeCandidate(
      { foodRelatedTurn: true, partySize: null, checkoutActive: false },
      { surfaceCount: 0 }
    );
    expect(open?.type).toBe('RECOLECTAR_PARTY_SIZE');
    expect(
      deriveCollectPartySizeCandidate(
        { foodRelatedTurn: true, partySize: null, checkoutActive: false },
        { surfaceCount: 1 }
      )
    ).toBeNull();
  });
});
