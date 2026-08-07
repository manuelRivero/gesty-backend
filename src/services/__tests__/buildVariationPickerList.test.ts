/**
 * Fase 4, Tarea 4.2 (PLAN-ACCION-VARIACIONES-PLATILLOS.md): picker de
 * variaciones para WhatsApp. D7 (lista, no botones) y D8 (máx. 10 filas,
 * truncar con warning si hay más).
 */

import { describe, expect, it, vi } from 'vitest';
import { buildVariationPickerList } from '../cart.service';

describe('buildVariationPickerList', () => {
  const item = { id: 'item-1', name: 'Pizza', variations: ['Especial', 'Roquefort'] };

  it('genera una fila por variación con el payload ADD_ITEM:<id>:<qty>:v<index>', () => {
    const list = buildVariationPickerList(item, 2);

    expect(list.action.sections).toHaveLength(1);
    expect(list.action.sections[0].rows).toEqual([
      { id: 'ADD_ITEM:item-1:2:v0', title: 'Especial' },
      { id: 'ADD_ITEM:item-1:2:v1', title: 'Roquefort' },
    ]);
  });

  it('menciona el nombre del platillo en el body', () => {
    const list = buildVariationPickerList(item, 1);
    expect(list.body.text).toContain('Pizza');
  });

  it('trunca a 10 filas y loguea un warning si hay más variaciones (D8)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manyVariations = Array.from({ length: 12 }, (_, i) => `Variación ${i}`);

    const list = buildVariationPickerList(
      { id: 'item-2', name: 'Pizza gigante', variations: manyVariations },
      1
    );

    expect(list.action.sections[0].rows).toHaveLength(10);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
