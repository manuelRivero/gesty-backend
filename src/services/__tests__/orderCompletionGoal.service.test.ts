/**
 * Tests del Goal derivado COMPLETAR_PEDIDO (Fase 0 del roadmap de migración).
 *
 * Cubre el derivador puro (ADR-0005/0006), el cálculo de permiso (ADR-0009)
 * y el revival del abandono (ADR-0005, corolario). prisma y
 * patchConversationMetadata se mockean para aislar las funciones de I/O sin
 * requerir BD (la escritura del ledger pasa por `intentLedger.repository.ts`,
 * que lee `conversation_state` antes de escribir para no pisar otras entradas).
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
  deriveOrderCompletionGoal,
  computeOrderCompletionPermission,
  getOrderCompletionLedger,
  recordOrderCompletionSurfaced,
  recordOrderCompletionAbandonment,
  reviveOrderCompletionIfAbandoned,
  buildOrderCompletionContextLines,
  ORDER_COMPLETION_SURFACE_BUDGET,
  ORDER_COMPLETION_COOLDOWN_MS,
  type OrderCompletionLedger,
} from '../orderCompletionGoal.service';
import { patchConversationMetadata } from '../../repositories';

const EMPTY_LEDGER: OrderCompletionLedger = {
  abandonment: false,
  surfaceCount: 0,
  lastSurfacedAt: null,
};

describe('deriveOrderCompletionGoal — derivador puro (ADR-0005/0006)', () => {
  it('abierto cuando hay ítems, no arrancó checkout y no fue abandonado', () => {
    const goal = deriveOrderCompletionGoal(
      { hasItems: true, checkoutActive: false },
      EMPTY_LEDGER
    );
    expect(goal.open).toBe(true);
  });

  it('cerrado si el carrito está vacío', () => {
    const goal = deriveOrderCompletionGoal(
      { hasItems: false, checkoutActive: false },
      EMPTY_LEDGER
    );
    expect(goal.open).toBe(false);
  });

  it('cerrado si el checkout ya arrancó (un solo agente en Fase 0)', () => {
    const goal = deriveOrderCompletionGoal(
      { hasItems: true, checkoutActive: true },
      EMPTY_LEDGER
    );
    expect(goal.open).toBe(false);
  });

  it('cerrado si el cliente abandonó explícitamente, aunque el carrito tenga ítems', () => {
    const goal = deriveOrderCompletionGoal(
      { hasItems: true, checkoutActive: false },
      { ...EMPTY_LEDGER, abandonment: true }
    );
    expect(goal.open).toBe(false);
  });
});

describe('computeOrderCompletionPermission — permiso que calcula el sistema (ADR-0009)', () => {
  const openGoal = { open: true };

  it('otorga permiso con presupuesto y cooldown libres', () => {
    const permission = computeOrderCompletionPermission(openGoal, EMPTY_LEDGER);
    expect(permission).toEqual({ granted: true, reason: 'granted' });
  });

  it('no otorga permiso si el Goal está cerrado', () => {
    const permission = computeOrderCompletionPermission({ open: false }, EMPTY_LEDGER);
    expect(permission).toEqual({ granted: false, reason: 'closed' });
  });

  it('enmudece (no muere) al agotar el presupuesto de insistencia', () => {
    const exhausted = { ...EMPTY_LEDGER, surfaceCount: ORDER_COMPLETION_SURFACE_BUDGET };
    const permission = computeOrderCompletionPermission(openGoal, exhausted);
    expect(permission).toEqual({ granted: false, reason: 'budget_exhausted' });
    // El Goal sigue abierto — "enmudece, no muere" (ADR-0008).
  });

  it('respeta el cooldown desde el último planteo', () => {
    const recent = {
      ...EMPTY_LEDGER,
      lastSurfacedAt: new Date(Date.now() - 1000).toISOString(),
    };
    const permission = computeOrderCompletionPermission(openGoal, recent);
    expect(permission).toEqual({ granted: false, reason: 'cooldown' });
  });

  it('vuelve a otorgar permiso una vez vencido el cooldown', () => {
    const old = {
      ...EMPTY_LEDGER,
      lastSurfacedAt: new Date(Date.now() - ORDER_COMPLETION_COOLDOWN_MS - 1000).toISOString(),
    };
    const permission = computeOrderCompletionPermission(openGoal, old);
    expect(permission).toEqual({ granted: true, reason: 'granted' });
  });
});

describe('getOrderCompletionLedger', () => {
  it('devuelve el ledger vacío por defecto si no hay metadata', () => {
    expect(getOrderCompletionLedger(undefined)).toEqual(EMPTY_LEDGER);
  });

  it('lee el ledger persistido bajo intentLedger.COMPLETAR_PEDIDO', () => {
    const ledger = getOrderCompletionLedger({
      intentLedger: { COMPLETAR_PEDIDO: { abandonment: true, surfaceCount: 2 } },
    });
    expect(ledger).toEqual({ abandonment: true, surfaceCount: 2, lastSurfacedAt: null });
  });
});

describe('efectos de I/O (patchConversationMetadata mockeado)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recordOrderCompletionSurfaced incrementa surfaceCount y setea lastSurfacedAt', async () => {
    await recordOrderCompletionSurfaced('conv-1', EMPTY_LEDGER);
    expect(patchConversationMetadata).toHaveBeenCalledWith('conv-1', {
      intentLedger: {
        COMPLETAR_PEDIDO: expect.objectContaining({ surfaceCount: 1, abandonment: false }),
      },
    });
  });

  it('recordOrderCompletionAbandonment marca abandonment sin tocar el resto', async () => {
    await recordOrderCompletionAbandonment('conv-1', { ...EMPTY_LEDGER, surfaceCount: 2 });
    expect(patchConversationMetadata).toHaveBeenCalledWith('conv-1', {
      intentLedger: {
        COMPLETAR_PEDIDO: { abandonment: true, surfaceCount: 2, lastSurfacedAt: null },
      },
    });
  });

  it('reviveOrderCompletionIfAbandoned resetea el ledger si estaba abandonado', async () => {
    await reviveOrderCompletionIfAbandoned('conv-1', { ...EMPTY_LEDGER, abandonment: true });
    expect(patchConversationMetadata).toHaveBeenCalledWith('conv-1', {
      intentLedger: { COMPLETAR_PEDIDO: EMPTY_LEDGER },
    });
  });

  it('reviveOrderCompletionIfAbandoned no hace nada si no había nada que revivir', async () => {
    await reviveOrderCompletionIfAbandoned('conv-1', EMPTY_LEDGER);
    expect(patchConversationMetadata).not.toHaveBeenCalled();
  });

  it('buildOrderCompletionContextLines no inyecta nada sin permiso, pero sigue logueando', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const lines = buildOrderCompletionContextLines({
      facts: { hasItems: false, checkoutActive: false },
      ledger: EMPTY_LEDGER,
      conversationId: 'conv-1',
    });
    expect(lines).toEqual([]);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('order_completion_ledger')
    );
    logSpy.mockRestore();
  });

  it('buildOrderCompletionContextLines inyecta la línea del Goal cuando hay permiso', async () => {
    const lines = buildOrderCompletionContextLines({
      facts: { hasItems: true, checkoutActive: false },
      ledger: EMPTY_LEDGER,
      conversationId: 'conv-1',
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('COMPLETAR_PEDIDO');
  });

  it('suprimida por saliencia (ADR-0009): no inyecta ni consume presupuesto aunque hubiera permiso', () => {
    const lines = buildOrderCompletionContextLines({
      facts: { hasItems: true, checkoutActive: false },
      ledger: EMPTY_LEDGER,
      conversationId: 'conv-1',
      suppressedBySaliency: true,
    });
    expect(lines).toEqual([]);
    expect(patchConversationMetadata).not.toHaveBeenCalled();
  });
});
