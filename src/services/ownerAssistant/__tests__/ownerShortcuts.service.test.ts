import { describe, expect, it } from 'vitest';
import {
  appendOwnerShortcutsToMessage,
  buildOwnerAmbiguityFallbackBody,
  buildOwnerShortcutsBody,
  extractOwnerToolInvocations,
  resolveUsedOwnerShortcutIds,
} from '../ownerShortcuts.service';

describe('ownerShortcuts.service', () => {
  it('menú completo en modo menu', () => {
    const body = buildOwnerShortcutsBody({
      usedActionIds: new Set(),
      mode: 'menu',
    });
    expect(body).toContain('Podés consultar:');
    expect(body).toContain('*Resumen*');
    expect(body).toContain('*Cola*');
  });

  it('tras briefing solo quedan acciones no cubiertas (Cola)', () => {
    const used = resolveUsedOwnerShortcutIds([
      { name: 'get_owner_briefing', args: { period: 'today' } },
    ]);
    const body = buildOwnerShortcutsBody({
      usedActionIds: used,
      mode: 'remaining',
    });
    expect(body).toContain('También podés:');
    expect(body).toContain('*Cola*');
    expect(body).not.toContain('*Ventas*');
    expect(body).not.toContain('*Resumen*');
  });

  it('tras cola quedan atajos de briefing', () => {
    const used = resolveUsedOwnerShortcutIds([{ name: 'get_live_orders' }]);
    const body = buildOwnerShortcutsBody({
      usedActionIds: used,
      mode: 'remaining',
    });
    expect(body).toContain('*Resumen*');
    expect(body).not.toContain('*Cola*');
  });

  it('sin tools restantes → string vacío', () => {
    const used = resolveUsedOwnerShortcutIds([
      { name: 'get_owner_briefing' },
      { name: 'get_live_orders' },
    ]);
    expect(
      buildOwnerShortcutsBody({ usedActionIds: used, mode: 'remaining' })
    ).toBe('');
  });

  it('extractOwnerToolInvocations lee tool_calls del mensaje', () => {
    const invocations = extractOwnerToolInvocations([
      {
        tool_calls: [
          { name: 'get_owner_briefing', args: { period: 'today' } },
        ],
      },
    ]);
    expect(invocations).toEqual([
      { name: 'get_owner_briefing', args: { period: 'today' } },
    ]);
  });

  it('appendOwnerShortcutsToMessage inserta en el body del formato bot', () => {
    const base = '🤖\n\n*Tu local* 📊\n\n10 pedidos hoy.';
    const withSc = appendOwnerShortcutsToMessage(
      base,
      'También podés:\n\n• *Cola* ahora'
    );
    expect(withSc).toContain('10 pedidos hoy.');
    expect(withSc).toContain('*Cola*');
    expect(withSc.startsWith('🤖')).toBe(true);
  });

  it('fallback de ambigüedad incluye menú', () => {
    const body = buildOwnerAmbiguityFallbackBody();
    expect(body).toContain('atajo');
    expect(body).toContain('*Resumen*');
  });
});
