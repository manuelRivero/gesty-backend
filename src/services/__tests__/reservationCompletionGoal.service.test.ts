/**
 * Tests del Goal derivado COMPLETAR_RESERVA (Fase 1b del roadmap de migración).
 *
 * Mismo patrón que orderCompletionGoal.service.test.ts, aplicado a reservas.
 * prisma y patchConversationMetadata se mockean para no requerir BD.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../repositories', () => ({
  patchConversationMetadata: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  prisma: {
    conversation_state: {
      findUnique: vi.fn().mockResolvedValue({ metadata: {} }),
    },
  },
}));

import {
  deriveReservationCompletionGoal,
  computeReservationCompletionPermission,
  getReservationCompletionLedger,
  hasReservationDraftInProgress,
  recordReservationCompletionSurfaced,
  recordReservationCompletionAbandonment,
  reviveReservationCompletionIfAbandoned,
  buildReservationCompletionContextLines,
  RESERVATION_COMPLETION_SURFACE_BUDGET,
  RESERVATION_COMPLETION_COOLDOWN_MS,
  type ReservationCompletionLedger,
} from '../reservationCompletionGoal.service';
import { patchConversationMetadata } from '../../repositories';

const EMPTY_LEDGER: ReservationCompletionLedger = {
  abandonment: false,
  surfaceCount: 0,
  lastSurfacedAt: null,
};

describe('hasReservationDraftInProgress', () => {
  it('false si no hay draft', () => {
    expect(hasReservationDraftInProgress(undefined)).toBe(false);
  });

  it('false si el draft está vacío', () => {
    expect(hasReservationDraftInProgress({})).toBe(false);
  });

  it('true si tiene al menos un campo cargado', () => {
    expect(hasReservationDraftInProgress({ date: '11/07/2026' })).toBe(true);
  });
});

describe('deriveReservationCompletionGoal — derivador puro', () => {
  it('abierto cuando hay borrador, el agente no tiene el turno y no fue abandonado', () => {
    const goal = deriveReservationCompletionGoal(
      { hasDraft: true, reservationAgentActive: false },
      EMPTY_LEDGER
    );
    expect(goal.open).toBe(true);
  });

  it('cerrado sin borrador', () => {
    const goal = deriveReservationCompletionGoal(
      { hasDraft: false, reservationAgentActive: false },
      EMPTY_LEDGER
    );
    expect(goal.open).toBe(false);
  });

  it('cerrado mientras el agente de reservas tiene el turno', () => {
    const goal = deriveReservationCompletionGoal(
      { hasDraft: true, reservationAgentActive: true },
      EMPTY_LEDGER
    );
    expect(goal.open).toBe(false);
  });

  it('cerrado si el cliente abandonó explícitamente', () => {
    const goal = deriveReservationCompletionGoal(
      { hasDraft: true, reservationAgentActive: false },
      { ...EMPTY_LEDGER, abandonment: true }
    );
    expect(goal.open).toBe(false);
  });
});

describe('computeReservationCompletionPermission', () => {
  const openGoal = { open: true };

  it('otorga permiso con presupuesto y cooldown libres', () => {
    expect(computeReservationCompletionPermission(openGoal, EMPTY_LEDGER)).toEqual({
      granted: true,
      reason: 'granted',
    });
  });

  it('enmudece al agotar el presupuesto', () => {
    const exhausted = { ...EMPTY_LEDGER, surfaceCount: RESERVATION_COMPLETION_SURFACE_BUDGET };
    expect(computeReservationCompletionPermission(openGoal, exhausted)).toEqual({
      granted: false,
      reason: 'budget_exhausted',
    });
  });

  it('respeta el cooldown', () => {
    const recent = {
      ...EMPTY_LEDGER,
      lastSurfacedAt: new Date(Date.now() - 1000).toISOString(),
    };
    expect(computeReservationCompletionPermission(openGoal, recent)).toEqual({
      granted: false,
      reason: 'cooldown',
    });
  });

  it('vuelve a otorgar permiso vencido el cooldown', () => {
    const old = {
      ...EMPTY_LEDGER,
      lastSurfacedAt: new Date(Date.now() - RESERVATION_COMPLETION_COOLDOWN_MS - 1000).toISOString(),
    };
    expect(computeReservationCompletionPermission(openGoal, old)).toEqual({
      granted: true,
      reason: 'granted',
    });
  });
});

describe('getReservationCompletionLedger', () => {
  it('ledger vacío por defecto', () => {
    expect(getReservationCompletionLedger(undefined)).toEqual(EMPTY_LEDGER);
  });

  it('lee el ledger persistido sin pisar el de COMPLETAR_PEDIDO', () => {
    const ledger = getReservationCompletionLedger({
      intentLedger: {
        COMPLETAR_PEDIDO: { abandonment: true },
        COMPLETAR_RESERVA: { surfaceCount: 1 },
      },
    });
    expect(ledger).toEqual({ abandonment: false, surfaceCount: 1, lastSurfacedAt: null });
  });
});

describe('efectos de I/O', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recordReservationCompletionSurfaced incrementa surfaceCount', async () => {
    await recordReservationCompletionSurfaced('conv-1', EMPTY_LEDGER);
    expect(patchConversationMetadata).toHaveBeenCalledWith('conv-1', {
      intentLedger: {
        COMPLETAR_RESERVA: expect.objectContaining({ surfaceCount: 1 }),
      },
    });
  });

  it('recordReservationCompletionAbandonment marca abandonment', async () => {
    await recordReservationCompletionAbandonment('conv-1', EMPTY_LEDGER);
    expect(patchConversationMetadata).toHaveBeenCalledWith('conv-1', {
      intentLedger: { COMPLETAR_RESERVA: { ...EMPTY_LEDGER, abandonment: true } },
    });
  });

  it('reviveReservationCompletionIfAbandoned resetea si estaba abandonado', async () => {
    await reviveReservationCompletionIfAbandoned('conv-1', { ...EMPTY_LEDGER, abandonment: true });
    expect(patchConversationMetadata).toHaveBeenCalledWith('conv-1', {
      intentLedger: { COMPLETAR_RESERVA: EMPTY_LEDGER },
    });
  });

  it('reviveReservationCompletionIfAbandoned no hace nada si no hay nada que revivir', async () => {
    await reviveReservationCompletionIfAbandoned('conv-1', EMPTY_LEDGER);
    expect(patchConversationMetadata).not.toHaveBeenCalled();
  });

  it('buildReservationCompletionContextLines no inyecta nada sin permiso', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const lines = buildReservationCompletionContextLines({
      facts: { hasDraft: false, reservationAgentActive: false },
      ledger: EMPTY_LEDGER,
      conversationId: 'conv-1',
      draft: undefined,
      hasEnvironments: false,
    });
    expect(lines).toEqual([]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('reservation_completion_ledger'));
    logSpy.mockRestore();
  });

  it('buildReservationCompletionContextLines inyecta la línea con permiso, mencionando lo que falta', () => {
    const lines = buildReservationCompletionContextLines({
      facts: { hasDraft: true, reservationAgentActive: false },
      ledger: EMPTY_LEDGER,
      conversationId: 'conv-1',
      draft: { date: '11/07/2026' },
      hasEnvironments: false,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('COMPLETAR_RESERVA');
    expect(lines[0]).toContain('horario');
  });

  it('suprimida por saliencia (ADR-0009): no inyecta ni consume presupuesto aunque hubiera permiso', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const lines = buildReservationCompletionContextLines({
      facts: { hasDraft: true, reservationAgentActive: false },
      ledger: EMPTY_LEDGER,
      conversationId: 'conv-1',
      draft: { date: '11/07/2026' },
      hasEnvironments: false,
      suppressedBySaliency: true,
    });
    expect(lines).toEqual([]);
    expect(patchConversationMetadata).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"permission":"suppressed_by_saliency"')
    );
    logSpy.mockRestore();
  });
});
