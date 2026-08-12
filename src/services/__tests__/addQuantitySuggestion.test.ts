import { describe, expect, it } from 'vitest';
import {
  isConfirmedAddQuantity,
  needsAddQuantityConfirmation,
  suggestAddQuantity,
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

  it(':1 no confirma cuando suggested ≥ 2; quantity ≥ 2 tampoco sin pendingReply', () => {
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
});
