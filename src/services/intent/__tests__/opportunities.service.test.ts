import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MenuCategoryTag } from '@prisma/client';
import {
  computeSuggestComplementPermission,
  deriveSuggestComplementCandidate,
  deriveSuggestComplementOpen,
  deriveSuggestAddressCandidate,
  deriveCollectPartySizeCandidate,
} from '../opportunities.service';
import {
  buildIntentLedgerView,
  deriveIntentCandidates,
  rankActiveIntent,
} from '../activeIntent.service';

const tags = (...t: MenuCategoryTag[]) => new Set<MenuCategoryTag>(t);

describe('SUGERIR_COMPLEMENTO — menú completo', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => logSpy.mockRestore());

  it('abre con solo postre (orden invertido)', () => {
    expect(
      deriveSuggestComplementOpen({ cartTags: tags('DESSERT'), checkoutActive: false })
    ).toBe(true);
    const c = deriveSuggestComplementCandidate(
      { cartTags: tags('DESSERT'), checkoutActive: false },
      { surfaceCount: 0 }
    );
    expect(c?.type).toBe('SUGERIR_COMPLEMENTO');
    expect(c?.hint).toMatch(/plato principal|entrada|bebida/i);
  });

  it('abre con MAIN sin bebida/postre', () => {
    expect(
      deriveSuggestComplementOpen({ cartTags: tags('MAIN'), checkoutActive: false })
    ).toBe(true);
  });

  it('cierra cuando el menú completo está cubierto', () => {
    expect(
      deriveSuggestComplementOpen({
        cartTags: tags('STARTER', 'MAIN', 'DRINK', 'DESSERT'),
        checkoutActive: false,
      })
    ).toBe(false);
  });

  it('con Goal COMPLETAR_PEDIDO con permiso → Opportunity suprimida en ranker (dual-inject la reinyecta aparte)', () => {
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
  });

  it('sin Goals abiertos → Opportunity puede ser activa', () => {
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
});

describe('computeSuggestComplementPermission', () => {
  it('refused → no granted', () => {
    expect(computeSuggestComplementPermission({ refused: true, surfaceCount: 0 })).toEqual({
      granted: false,
      reason: 'refused',
    });
  });

  it('1ª ola sin engaged → awaiting_engagement', () => {
    expect(
      computeSuggestComplementPermission({
        surfaceCount: 1,
        lastSurfacedAt: new Date().toISOString(),
      })
    ).toEqual({ granted: false, reason: 'awaiting_engagement' });
  });

  it('engaged + cooldown vencido → granted (segunda ola)', () => {
    const now = Date.parse('2026-08-10T12:10:00.000Z');
    expect(
      computeSuggestComplementPermission(
        {
          surfaceCount: 1,
          engaged: true,
          lastSurfacedAt: '2026-08-10T12:00:00.000Z',
        },
        now
      )
    ).toEqual({ granted: true, reason: 'ok' });
  });

  it('engaged + cooldown activo → cooldown', () => {
    const now = Date.parse('2026-08-10T12:01:00.000Z');
    expect(
      computeSuggestComplementPermission(
        {
          surfaceCount: 1,
          engaged: true,
          lastSurfacedAt: '2026-08-10T12:00:00.000Z',
        },
        now
      )
    ).toEqual({ granted: false, reason: 'cooldown' });
  });

  it('derive null tras refused', () => {
    expect(
      deriveSuggestComplementCandidate(
        { cartTags: tags('MAIN'), checkoutActive: false },
        { refused: true, surfaceCount: 0 }
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
