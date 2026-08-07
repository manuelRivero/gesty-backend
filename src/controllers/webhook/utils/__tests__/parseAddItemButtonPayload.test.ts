import { describe, expect, it } from 'vitest';
import { parseAddItemButtonPayload } from '../index';

const UUID = '11111111-1111-1111-1111-111111111111';

describe('parseAddItemButtonPayload', () => {
  it('formato legacy sin cantidad: solo productId', () => {
    expect(parseAddItemButtonPayload(`ADD_ITEM:${UUID}`)).toEqual({
      productId: UUID,
      quantityFromPayload: null,
      variationIndex: null,
    });
  });

  it('formato con cantidad', () => {
    expect(parseAddItemButtonPayload(`ADD_ITEM:${UUID}:3`)).toEqual({
      productId: UUID,
      quantityFromPayload: 3,
      variationIndex: null,
    });
  });

  it('formato con cantidad y variación', () => {
    expect(parseAddItemButtonPayload(`ADD_ITEM:${UUID}:2:v0`)).toEqual({
      productId: UUID,
      quantityFromPayload: 2,
      variationIndex: 0,
    });
    expect(parseAddItemButtonPayload(`ADD_ITEM:${UUID}:1:v9`)).toEqual({
      productId: UUID,
      quantityFromPayload: 1,
      variationIndex: 9,
    });
  });

  it('payload que no empieza con ADD_ITEM: devuelve vacío', () => {
    expect(parseAddItemButtonPayload('OTHER_INTENT:foo')).toEqual({
      productId: '',
      quantityFromPayload: null,
      variationIndex: null,
    });
  });

  it('cantidad fuera de rango (0 o >99) se ignora, tail queda en productId', () => {
    expect(parseAddItemButtonPayload(`ADD_ITEM:${UUID}:0`)).toEqual({
      productId: `${UUID}:0`,
      quantityFromPayload: null,
      variationIndex: null,
    });
    expect(parseAddItemButtonPayload(`ADD_ITEM:${UUID}:100`)).toEqual({
      productId: `${UUID}:100`,
      quantityFromPayload: null,
      variationIndex: null,
    });
  });

  it('solo productId con espacios se trimea', () => {
    expect(parseAddItemButtonPayload(`ADD_ITEM: ${UUID} `)).toEqual({
      productId: UUID,
      quantityFromPayload: null,
      variationIndex: null,
    });
  });
});
