import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildIntentLedgerView,
  computeCatalogPermission,
  deriveIntentCandidates,
  rankActiveIntent,
  type IntentDerivationContext,
} from '../activeIntent.service';
import type { IntentCandidate } from '../../../domain/intent/family';
import { getIntentCatalogEntry } from '../../../domain/intent/family';

const EMPTY_LEDGER = { abandonment: false, surfaceCount: 0, lastSurfacedAt: null };

const baseCtx = (overrides?: Partial<IntentDerivationContext>): IntentDerivationContext => ({
  order: {
    facts: { hasItems: true, checkoutActive: false },
    ledger: EMPTY_LEDGER,
  },
  reservation: {
    facts: { hasDraft: true, reservationAgentActive: false },
    ledger: EMPTY_LEDGER,
    hasEnvironments: false,
  },
  ...overrides,
});

describe('deriveIntentCandidates', () => {
  it('emite ambos Goals cuando están abiertos', () => {
    const candidates = deriveIntentCandidates(baseCtx());
    expect(candidates.map((c) => c.type).sort()).toEqual([
      'COMPLETAR_PEDIDO',
      'COMPLETAR_RESERVA',
    ]);
  });

  it('no emite Goal cerrado', () => {
    const candidates = deriveIntentCandidates(
      baseCtx({
        order: {
          facts: { hasItems: false, checkoutActive: false },
          ledger: EMPTY_LEDGER,
        },
      })
    );
    expect(candidates.map((c) => c.type)).toEqual(['COMPLETAR_RESERVA']);
  });
});

describe('rankActiveIntent (A.3)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('ambos Goals reanudables abiertos → uno activo (pedido), el otro suppressed', () => {
    const candidates = deriveIntentCandidates(baseCtx());
    const ledger = buildIntentLedgerView({
      order: EMPTY_LEDGER,
      reservation: EMPTY_LEDGER,
    });
    const result = rankActiveIntent(candidates, ledger, { conversationId: 'c1' });

    expect(result.active?.type).toBe('COMPLETAR_PEDIDO');
    expect(result.suppressed.map((c) => c.type)).toContain('COMPLETAR_RESERVA');
    expect(result.permission.granted).toBe(true);
    expect(result.intentsPlanteadosPorTurno).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('active_rank'));
  });

  it('Goal con presupuesto agotado no gana aunque no haya otros candidatos', () => {
    const candidates = deriveIntentCandidates(
      baseCtx({
        reservation: {
          facts: { hasDraft: false, reservationAgentActive: false },
          ledger: EMPTY_LEDGER,
          hasEnvironments: false,
        },
      })
    );
    const ledger = buildIntentLedgerView({
      order: { abandonment: false, surfaceCount: 3, lastSurfacedAt: null },
    });
    const result = rankActiveIntent(candidates, ledger);

    expect(result.active).toBeNull();
    expect(result.permission.granted).toBe(false);
    expect(result.permission.reason).toBe('budget_exhausted');
    expect(result.intentsPlanteadosPorTurno).toBe(0);
  });

  it('lista vacía → active null, sin lanzar', () => {
    const result = rankActiveIntent([], {});
    expect(result.active).toBeNull();
    expect(result.suppressed).toEqual([]);
    expect(result.intentsPlanteadosPorTurno).toBe(0);
  });

  it('Opportunity pierde ante Goal con permiso', () => {
    const cat = getIntentCatalogEntry('SUGERIR_COMPLEMENTO');
    const opportunity: IntentCandidate = {
      type: 'SUGERIR_COMPLEMENTO',
      kind: cat.kind,
      pressure: cat.pressure,
      closeMode: cat.closeMode,
      hint: '- Opportunity: sugerir complemento',
      tieBreak: 10,
    };
    const candidates = [
      ...deriveIntentCandidates(
        baseCtx({
          reservation: {
            facts: { hasDraft: false, reservationAgentActive: false },
            ledger: EMPTY_LEDGER,
            hasEnvironments: false,
          },
        })
      ),
      opportunity,
    ];
    const result = rankActiveIntent(
      candidates,
      buildIntentLedgerView({ order: EMPTY_LEDGER })
    );
    expect(result.active?.type).toBe('COMPLETAR_PEDIDO');
    expect(result.suppressed.map((c) => c.type)).toContain('SUGERIR_COMPLEMENTO');
  });
});

describe('computeCatalogPermission', () => {
  it('respeta cooldown del catálogo', () => {
    const now = Date.parse('2026-08-09T12:00:00.000Z');
    const result = computeCatalogPermission(
      'COMPLETAR_PEDIDO',
      { surfaceCount: 1, lastSurfacedAt: '2026-08-09T11:55:00.000Z' },
      now
    );
    expect(result).toEqual({ granted: false, reason: 'cooldown' });
  });

  it('Opportunity expirada por TTL → expired', () => {
    const now = Date.parse('2026-08-09T12:00:00.000Z');
    const result = computeCatalogPermission(
      'CONFIRMAR_OFERTA',
      { openedAt: '2026-08-09T11:00:00.000Z', surfaceCount: 0 },
      now
    );
    expect(result).toEqual({ granted: false, reason: 'expired' });
  });

  it('Alert emitida no vuelve', () => {
    const result = computeCatalogPermission('PEDIDO_POR_EXPIRAR', {
      emitted: true,
      surfaceCount: 1,
    });
    expect(result).toEqual({ granted: false, reason: 'emitted' });
  });
});
