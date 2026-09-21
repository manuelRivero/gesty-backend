import { describe, expect, it } from 'vitest';
import {
  isConfirmedAddQuantity,
  needsAddQuantityConfirmation,
  suggestAddQuantity,
  userMessageStatesUnitQuantity,
} from '../addQuantitySuggestion';

describe('suggestAddQuantity', () => {
  it('(3,1) → 3 portion_math', () => {
    expect(suggestAddQuantity({ partySize: 3, servesPeople: 1 })).toEqual({
      suggestedQuantity: 3,
      reason: 'portion_math',
    });
  });

  it('(3,2) → 2 portion_math', () => {
    expect(suggestAddQuantity({ partySize: 3, servesPeople: 2 })).toEqual({
      suggestedQuantity: 2,
      reason: 'portion_math',
    });
  });

  it('(2,2) → 1 default_one', () => {
    expect(suggestAddQuantity({ partySize: 2, servesPeople: 2 })).toEqual({
      suggestedQuantity: 1,
      reason: 'default_one',
    });
  });

  it('(null,1) → 1', () => {
    expect(suggestAddQuantity({ partySize: null, servesPeople: 1 })).toEqual({
      suggestedQuantity: 1,
      reason: 'default_one',
    });
  });

  it('(4,null) → 4 party_unknown_serves', () => {
    expect(suggestAddQuantity({ partySize: 4, servesPeople: null })).toEqual({
      suggestedQuantity: 4,
      reason: 'party_unknown_serves',
    });
  });
});

describe('needsAddQuantityConfirmation / isConfirmedAddQuantity', () => {
  it('suggested ≥ 2 exige confirmación', () => {
    expect(
      needsAddQuantityConfirmation({ suggestedQuantity: 3, partySize: 3 })
    ).toBe(true);
    expect(
      needsAddQuantityConfirmation({ suggestedQuantity: 1, partySize: 1 })
    ).toBe(false);
  });

  it(':1 / quantity sin mensaje no confirma cuando suggested ≥ 2', () => {
    expect(
      isConfirmedAddQuantity({ quantity: 1, suggestedQuantity: 3 })
    ).toBe(false);
    expect(
      isConfirmedAddQuantity({ quantity: 2, suggestedQuantity: 3 })
    ).toBe(false);
    expect(
      isConfirmedAddQuantity({ quantity: 2, suggestedQuantity: 2 })
    ).toBe(false);
    expect(
      isConfirmedAddQuantity({ quantity: 1, suggestedQuantity: 1 })
    ).toBe(true);
  });

  it('con pendingReply, quantity 1 o 2 confirma aunque suggested ≥ 2', () => {
    expect(
      isConfirmedAddQuantity({
        quantity: 1,
        suggestedQuantity: 3,
        pendingReply: true,
      })
    ).toBe(true);
    expect(
      isConfirmedAddQuantity({
        quantity: 2,
        suggestedQuantity: 2,
        pendingReply: true,
      })
    ).toBe(true);
    expect(
      isConfirmedAddQuantity({
        quantity: 1,
        suggestedQuantity: 3,
        pendingReply: false,
      })
    ).toBe(false);
  });

  it('mensaje del turno con unidades confirma aunque suggested ≥ 2', () => {
    expect(
      isConfirmedAddQuantity({
        quantity: 2,
        suggestedQuantity: 3,
        userMessage: 'Dame dos adobo por favor',
      })
    ).toBe(true);
    expect(
      isConfirmedAddQuantity({
        quantity: 2,
        suggestedQuantity: 2,
        userMessage: 'sumá 2 ají de gallina',
      })
    ).toBe(true);
    expect(
      isConfirmedAddQuantity({
        quantity: 3,
        suggestedQuantity: 3,
        userMessage: 'quiero el adobo',
      })
    ).toBe(false);
  });
});

describe('userMessageStatesUnitQuantity', () => {
  it('detecta dame/sumá + número o palabra', () => {
    expect(userMessageStatesUnitQuantity('Dame dos adobo por favor', 2)).toBe(true);
    expect(userMessageStatesUnitQuantity('sumá 2 ceviches', 2)).toBe(true);
    expect(userMessageStatesUnitQuantity('2× adobo', 2)).toBe(true);
  });

  it('no toma party size como unidades', () => {
    expect(userMessageStatesUnitQuantity('somos 3', 3)).toBe(false);
    expect(userMessageStatesUnitQuantity('comida para 3', 3)).toBe(false);
    expect(userMessageStatesUnitQuantity('mesa para 4 el viernes', 4)).toBe(false);
  });

  it('no confirma si el número del arg no está en el mensaje', () => {
    expect(userMessageStatesUnitQuantity('Dame dos adobo', 3)).toBe(false);
    expect(userMessageStatesUnitQuantity('el adobo', 2)).toBe(false);
  });
});
