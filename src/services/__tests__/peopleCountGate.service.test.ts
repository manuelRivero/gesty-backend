import { describe, expect, it } from 'vitest';
import { ConversationIntent } from '../../types/conversationIntent';
import {
  buildPartySizeJustConfirmedContextLines,
  shouldBlockForMissingPeopleCount,
  shouldTreatBareNumberAsPartySize,
} from '../peopleCountGate.service';

describe('peopleCountGate', () => {
  it('bloquea PRODUCT_QUERY/ORDER_FOOD sin party size en metadata', () => {
    expect(
      shouldBlockForMissingPeopleCount({
        intent: ConversationIntent.PRODUCT_QUERY,
        metadata: {},
        detectionQuantity: 1, // "un lomito" — NO cuenta como personas
      })
    ).toBe(true);

    expect(
      shouldBlockForMissingPeopleCount({
        intent: ConversationIntent.ORDER_FOOD,
        metadata: {},
        detectionQuantity: 2,
      })
    ).toBe(true);
  });

  it('no bloquea si peopleCount ya está persistido', () => {
    expect(
      shouldBlockForMissingPeopleCount({
        intent: ConversationIntent.PRODUCT_QUERY,
        metadata: { peopleCount: 2, requestedPartySize: 2 },
        detectionQuantity: null,
      })
    ).toBe(false);
  });

  it('trata "2" solo como party size si aún no hay personas y el intent es cantidad', () => {
    expect(
      shouldTreatBareNumberAsPartySize({
        userMessage: '2',
        intent: ConversationIntent.MODIFY_QUANTITY,
        metadata: {},
        detectedProductName: null,
      })
    ).toBe(true);

    expect(
      shouldTreatBareNumberAsPartySize({
        userMessage: '2 lomitos',
        intent: ConversationIntent.MODIFY_QUANTITY,
        metadata: {},
        detectedProductName: null,
      })
    ).toBe(false);

    expect(
      shouldTreatBareNumberAsPartySize({
        userMessage: '2',
        intent: ConversationIntent.MODIFY_QUANTITY,
        metadata: { peopleCount: 3 },
        detectedProductName: null,
      })
    ).toBe(false);

    expect(
      shouldTreatBareNumberAsPartySize({
        userMessage: '2',
        intent: ConversationIntent.MODIFY_QUANTITY,
        metadata: {},
        detectedProductName: 'lomito',
      })
    ).toBe(false);
  });

  it('buildPartySizeJustConfirmedContextLines: hint solo con N > 0', () => {
    expect(buildPartySizeJustConfirmedContextLines(undefined)).toEqual([]);
    expect(buildPartySizeJustConfirmedContextLines(0)).toEqual([]);
    const lines = buildPartySizeJustConfirmedContextLines(3);
    expect(lines.join('\n')).toContain('Party size recién confirmado (3)');
    expect(lines.join('\n')).toContain('PROHIBIDO present_product_cta(ADD_ITEM)');
  });
});
