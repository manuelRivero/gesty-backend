/**
 * Tests del Goal derivado COMPLETAR_PEDIDO (Fase 0 del roadmap de migración).
 *
 * Cubre el derivador puro (ADR-0005/0006), el cálculo de permiso (ADR-0009)
 * y el revival del abandono (ADR-0005, corolario). patchConversationMetadata
 * se mockea para aislar las funciones de I/O sin requerir BD.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../repositories', () => ({
  patchConversationMetadata: vi.fn(),
}));

import {
  deriveCompletarPedidoGoal,
  computeCompletarPedidoPermission,
  getCompletarPedidoLedger,
  recordCompletarPedidoSurfaced,
  recordCompletarPedidoAbandonment,
  reviveCompletarPedidoIfAbandoned,
  buildCompletarPedidoContextLines,
  COMPLETAR_PEDIDO_SURFACE_BUDGET,
  COMPLETAR_PEDIDO_COOLDOWN_MS,
  type CompletarPedidoLedger,
} from '../completarPedidoGoal.service';
import { patchConversationMetadata } from '../../repositories';

const EMPTY_LEDGER: CompletarPedidoLedger = {
  abandonment: false,
  surfaceCount: 0,
  lastSurfacedAt: null,
};

describe('deriveCompletarPedidoGoal — derivador puro (ADR-0005/0006)', () => {
  it('abierto cuando hay ítems, no arrancó checkout y no fue abandonado', () => {
    const goal = deriveCompletarPedidoGoal(
      { hasItems: true, checkoutActive: false },
      EMPTY_LEDGER
    );
    expect(goal.open).toBe(true);
  });

  it('cerrado si el carrito está vacío', () => {
    const goal = deriveCompletarPedidoGoal(
      { hasItems: false, checkoutActive: false },
      EMPTY_LEDGER
    );
    expect(goal.open).toBe(false);
  });

  it('cerrado si el checkout ya arrancó (un solo agente en Fase 0)', () => {
    const goal = deriveCompletarPedidoGoal(
      { hasItems: true, checkoutActive: true },
      EMPTY_LEDGER
    );
    expect(goal.open).toBe(false);
  });

  it('cerrado si el cliente abandonó explícitamente, aunque el carrito tenga ítems', () => {
    const goal = deriveCompletarPedidoGoal(
      { hasItems: true, checkoutActive: false },
      { ...EMPTY_LEDGER, abandonment: true }
    );
    expect(goal.open).toBe(false);
  });
});

describe('computeCompletarPedidoPermission — permiso que calcula el sistema (ADR-0009)', () => {
  const openGoal = { open: true };

  it('otorga permiso con presupuesto y cooldown libres', () => {
    const permission = computeCompletarPedidoPermission(openGoal, EMPTY_LEDGER);
    expect(permission).toEqual({ granted: true, reason: 'granted' });
  });

  it('no otorga permiso si el Goal está cerrado', () => {
    const permission = computeCompletarPedidoPermission({ open: false }, EMPTY_LEDGER);
    expect(permission).toEqual({ granted: false, reason: 'closed' });
  });

  it('enmudece (no muere) al agotar el presupuesto de insistencia', () => {
    const exhausted = { ...EMPTY_LEDGER, surfaceCount: COMPLETAR_PEDIDO_SURFACE_BUDGET };
    const permission = computeCompletarPedidoPermission(openGoal, exhausted);
    expect(permission).toEqual({ granted: false, reason: 'budget_exhausted' });
    // El Goal sigue abierto — "enmudece, no muere" (ADR-0008).
  });

  it('respeta el cooldown desde el último planteo', () => {
    const recent = {
      ...EMPTY_LEDGER,
      lastSurfacedAt: new Date(Date.now() - 1000).toISOString(),
    };
    const permission = computeCompletarPedidoPermission(openGoal, recent);
    expect(permission).toEqual({ granted: false, reason: 'cooldown' });
  });

  it('vuelve a otorgar permiso una vez vencido el cooldown', () => {
    const old = {
      ...EMPTY_LEDGER,
      lastSurfacedAt: new Date(Date.now() - COMPLETAR_PEDIDO_COOLDOWN_MS - 1000).toISOString(),
    };
    const permission = computeCompletarPedidoPermission(openGoal, old);
    expect(permission).toEqual({ granted: true, reason: 'granted' });
  });
});

describe('getCompletarPedidoLedger', () => {
  it('devuelve el ledger vacío por defecto si no hay metadata', () => {
    expect(getCompletarPedidoLedger(undefined)).toEqual(EMPTY_LEDGER);
  });

  it('lee el ledger persistido bajo intentLedger.COMPLETAR_PEDIDO', () => {
    const ledger = getCompletarPedidoLedger({
      intentLedger: { COMPLETAR_PEDIDO: { abandonment: true, surfaceCount: 2 } },
    });
    expect(ledger).toEqual({ abandonment: true, surfaceCount: 2, lastSurfacedAt: null });
  });
});

describe('efectos de I/O (patchConversationMetadata mockeado)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recordCompletarPedidoSurfaced incrementa surfaceCount y setea lastSurfacedAt', async () => {
    await recordCompletarPedidoSurfaced('conv-1', EMPTY_LEDGER);
    expect(patchConversationMetadata).toHaveBeenCalledWith('conv-1', {
      intentLedger: {
        COMPLETAR_PEDIDO: expect.objectContaining({ surfaceCount: 1, abandonment: false }),
      },
    });
  });

  it('recordCompletarPedidoAbandonment marca abandonment sin tocar el resto', async () => {
    await recordCompletarPedidoAbandonment('conv-1', { ...EMPTY_LEDGER, surfaceCount: 2 });
    expect(patchConversationMetadata).toHaveBeenCalledWith('conv-1', {
      intentLedger: {
        COMPLETAR_PEDIDO: { abandonment: true, surfaceCount: 2, lastSurfacedAt: null },
      },
    });
  });

  it('reviveCompletarPedidoIfAbandoned resetea el ledger si estaba abandonado', async () => {
    await reviveCompletarPedidoIfAbandoned('conv-1', { ...EMPTY_LEDGER, abandonment: true });
    expect(patchConversationMetadata).toHaveBeenCalledWith('conv-1', {
      intentLedger: { COMPLETAR_PEDIDO: EMPTY_LEDGER },
    });
  });

  it('reviveCompletarPedidoIfAbandoned no hace nada si no había nada que revivir', async () => {
    await reviveCompletarPedidoIfAbandoned('conv-1', EMPTY_LEDGER);
    expect(patchConversationMetadata).not.toHaveBeenCalled();
  });

  it('buildCompletarPedidoContextLines no inyecta nada sin permiso, pero sigue logueando', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const lines = buildCompletarPedidoContextLines({
      facts: { hasItems: false, checkoutActive: false },
      ledger: EMPTY_LEDGER,
      conversationId: 'conv-1',
    });
    expect(lines).toEqual([]);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('completar_pedido_ledger')
    );
    logSpy.mockRestore();
  });

  it('buildCompletarPedidoContextLines inyecta la línea del Goal cuando hay permiso', async () => {
    const lines = buildCompletarPedidoContextLines({
      facts: { hasItems: true, checkoutActive: false },
      ledger: EMPTY_LEDGER,
      conversationId: 'conv-1',
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('COMPLETAR_PEDIDO');
  });
});
