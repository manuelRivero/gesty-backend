import { describe, expect, it } from 'vitest';
import {
  isDishSuggestionDelegationReason,
  shouldBlockDishFaqWithoutPartySize,
} from '../dishFaqPartySizeGate';

describe('dishFaqPartySizeGate', () => {
  it('detecta el reason inventado del 21/9', () => {
    expect(isDishSuggestionDelegationReason('sugerir platos para 1 por raciones')).toBe(
      true
    );
  });

  it('no trata un FAQ de precio como sugerencia de platos', () => {
    expect(isDishSuggestionDelegationReason('precio del matambre')).toBe(false);
  });

  it('bloquea FAQ de platos sin Fact de personas; el 1 del reason no cuenta', () => {
    expect(
      shouldBlockDishFaqWithoutPartySize({
        delegateToMain: true,
        reason: 'sugerir platos para 1 por raciones',
        partySize: undefined,
      })
    ).toBe(true);
    expect(
      shouldBlockDishFaqWithoutPartySize({
        delegateToMain: true,
        reason: 'sugerir platos para 6 por raciones',
        partySize: 6,
      })
    ).toBe(false);
  });
});
