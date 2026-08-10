import { describe, expect, it } from 'vitest';
import {
  matchManagementShortcut,
  normalizeManagementShortcutText,
} from '../managementShortcut.service';

describe('managementShortcut', () => {
  it('normaliza negritas y acentos', () => {
    expect(normalizeManagementShortcutText('• *Nota* del pedido')).toBe(
      'nota del pedido'
    );
    expect(normalizeManagementShortcutText('Menú')).toBe('menu');
  });

  it('matchea atajos tipables de gestión', () => {
    expect(matchManagementShortcut('pedido')).toBe('view_cart');
    expect(matchManagementShortcut('Ver pedido')).toBe('view_cart');
    expect(matchManagementShortcut('nota')).toBe('note');
    expect(matchManagementShortcut('Notas del pedido')).toBe('note');
    expect(matchManagementShortcut('menú')).toBe('menu');
    expect(matchManagementShortcut('Modificar pedido')).toBe('edit_cart');
    expect(matchManagementShortcut('Finalizar')).toBe('checkout');
    expect(matchManagementShortcut('lomo con poca sal')).toBeNull();
    expect(matchManagementShortcut('2')).toBeNull();
  });
});
