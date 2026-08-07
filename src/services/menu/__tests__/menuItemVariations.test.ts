import { describe, expect, it } from 'vitest';
import {
  hasVariations,
  matchVariation,
  normalizeVariationsInput,
  variationByIndex,
} from '../menuItemVariations';

describe('normalizeVariationsInput', () => {
  it('descarta strings vacíos y de solo espacios', () => {
    expect(normalizeVariationsInput(['Roquefort', '  ', '', 'Especial'])).toEqual([
      'Roquefort',
      'Especial',
    ]);
  });

  it('hace dedupe case-insensitive conservando la primera grafía', () => {
    expect(normalizeVariationsInput(['Roquefort', 'roquefort', 'ROQUEFORT'])).toEqual([
      'Roquefort',
    ]);
  });

  it('preserva el orden de carga', () => {
    expect(normalizeVariationsInput(['Napolitana', 'Especial', 'Roquefort'])).toEqual([
      'Napolitana',
      'Especial',
      'Roquefort',
    ]);
  });

  it('devuelve [] para null o undefined', () => {
    expect(normalizeVariationsInput(null)).toEqual([]);
    expect(normalizeVariationsInput(undefined)).toEqual([]);
  });
});

describe('hasVariations', () => {
  it('es true cuando hay al menos una variación', () => {
    expect(hasVariations({ variations: ['Roquefort'] })).toBe(true);
  });

  it('es false cuando la lista está vacía', () => {
    expect(hasVariations({ variations: [] })).toBe(false);
  });
});

describe('matchVariation', () => {
  const variations = ['Especial', 'Roquefort', 'Napolitana'];

  it('matchea exacto', () => {
    expect(matchVariation('Roquefort', variations)).toEqual({
      status: 'ok',
      value: 'Roquefort',
    });
  });

  it('matchea con letra faltante, mayúsculas y texto extra vía includes', () => {
    expect(matchVariation('roquefor', variations)).toEqual({
      status: 'ok',
      value: 'Roquefort',
    });
    expect(matchVariation('ROQUEFORT', variations)).toEqual({
      status: 'ok',
      value: 'Roquefort',
    });
    expect(matchVariation('de Roquefort', variations)).toEqual({
      status: 'ok',
      value: 'Roquefort',
    });
  });

  it('matchea sin acento', () => {
    expect(matchVariation('cafe', ['Café'])).toEqual({
      status: 'ok',
      value: 'Café',
    });
  });

  it('devuelve ambiguous cuando hay varios candidatos', () => {
    const result = matchVariation('pizza', ['Pizza especial', 'Pizza napolitana']);
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.candidates).toEqual(['Pizza especial', 'Pizza napolitana']);
    }
  });

  it('devuelve not_found con input vacío', () => {
    expect(matchVariation('', variations)).toEqual({ status: 'not_found' });
    expect(matchVariation('   ', variations)).toEqual({ status: 'not_found' });
  });

  it('devuelve not_found cuando no hay ningún candidato', () => {
    expect(matchVariation('cuatro quesos', variations)).toEqual({
      status: 'not_found',
    });
  });
});

describe('variationByIndex', () => {
  const variations = ['Especial', 'Roquefort'];

  it('resuelve un índice válido', () => {
    expect(variationByIndex(variations, 1)).toBe('Roquefort');
  });

  it('devuelve null para índice fuera de rango', () => {
    expect(variationByIndex(variations, 5)).toBeNull();
    expect(variationByIndex(variations, -1)).toBeNull();
  });
});
