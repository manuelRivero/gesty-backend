import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config/env')>();
  return {
    ...actual,
    isDraftOrderWorkerEnabled: vi.fn(() => true),
  };
});

import {
  derivePedidoPorExpirarCandidate,
  derivePedidoPorExpirarOpen,
  deriveFueraDeCoberturaCandidate,
  isCriticalAlert,
  PEDIDO_POR_EXPIRAR_WINDOW_MS,
} from '../alerts.service';
import { isDraftOrderWorkerEnabled } from '../../../config/env';
import { deriveSuggestComplementCandidate } from '../opportunities.service';
import { rankActiveIntent } from '../activeIntent.service';
import type { MenuCategoryTag } from '@prisma/client';

describe('PEDIDO_POR_EXPIRAR (D.1)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(isDraftOrderWorkerEnabled).mockReturnValue(true);
  });
  afterEach(() => logSpy.mockRestore());

  it('condiciones → activa; tras emitir → no vuelve', () => {
    const now = Date.parse('2026-08-09T12:00:00.000Z');
    const expiresAt = new Date(now + PEDIDO_POR_EXPIRAR_WINDOW_MS / 2);
    const open = derivePedidoPorExpirarCandidate(
      { hasItems: true, expiresAt },
      { surfaceCount: 0 },
      now
    );
    expect(open?.type).toBe('PEDIDO_POR_EXPIRAR');

    const afterEmit = derivePedidoPorExpirarCandidate(
      { hasItems: true, expiresAt },
      { emitted: true, surfaceCount: 1 },
      now
    );
    expect(afterEmit).toBeNull();
  });

  it('con worker desactivado → no se abre', () => {
    vi.mocked(isDraftOrderWorkerEnabled).mockReturnValue(false);
    const now = Date.parse('2026-08-09T12:00:00.000Z');
    const expiresAt = new Date(now + PEDIDO_POR_EXPIRAR_WINDOW_MS / 2);
    expect(
      derivePedidoPorExpirarOpen({ hasItems: true, expiresAt }, now)
    ).toBe(false);
    expect(
      derivePedidoPorExpirarCandidate(
        { hasItems: true, expiresAt },
        { surfaceCount: 0 },
        now
      )
    ).toBeNull();
  });

  it('el cliente no puede silenciarla con abandono (crítica)', () => {
    expect(isCriticalAlert('PEDIDO_POR_EXPIRAR')).toBe(true);
    // El derivador no mira abandonment — solo Facts + emitted (+ worker on).
    const now = Date.parse('2026-08-09T12:00:00.000Z');
    const c = derivePedidoPorExpirarCandidate(
      { hasItems: true, expiresAt: new Date(now + 60_000) },
      { abandonment: true, surfaceCount: 0 },
      now
    );
    expect(c?.type).toBe('PEDIDO_POR_EXPIRAR');
  });
});

describe('FUERA_DE_COBERTURA (D.2)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => logSpy.mockRestore());

  it('fuera de zona → Alert activa y bloquea Opportunities', () => {
    const alert = deriveFueraDeCoberturaCandidate(
      { hasAddress: true, isInCoverage: false },
      { surfaceCount: 0 }
    );
    const opportunity = deriveSuggestComplementCandidate(
      { cartTags: new Set<MenuCategoryTag>(['MAIN']), checkoutActive: false },
      { surfaceCount: 0 }
    );
    const ranked = rankActiveIntent(
      [alert!, opportunity!],
      {
        FUERA_DE_COBERTURA: { surfaceCount: 0 },
        SUGERIR_COMPLEMENTO: { surfaceCount: 0 },
      }
    );
    expect(ranked.active?.type).toBe('FUERA_DE_COBERTURA');
    expect(ranked.suppressed.map((c) => c.type)).toContain('SUGERIR_COMPLEMENTO');
  });

  it('dirección en cobertura → Alert cierra; emitted no basta como cierre', () => {
    // Con Fact resuelto, el derivador no emite — aunque el Ledger diga emitted.
    expect(
      deriveFueraDeCoberturaCandidate(
        { hasAddress: true, isInCoverage: true },
        { emitted: true, surfaceCount: 1 }
      )
    ).toBeNull();

    // Mientras el Fact persista (fuera de zona), emitted NO cierra el Intent:
    // sigue rankeable (cooldown mediante) — no es closeMode emission.
    const stillOpen = deriveFueraDeCoberturaCandidate(
      { hasAddress: true, isInCoverage: false },
      { emitted: true, surfaceCount: 1 }
    );
    expect(stillOpen?.type).toBe('FUERA_DE_COBERTURA');
  });
});
