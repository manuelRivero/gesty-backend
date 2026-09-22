import { describe, expect, it } from 'vitest';
import {
  buildPendingReservationDishFaq,
  buildPendingReservationDishFaqContextLines,
  dishFaqDelegationReasonForPartySize,
  dishFaqUserMessageForHybrid,
  getPendingReservationDishFaq,
  shouldFulfillReservationDishFaq,
  CANONICAL_DISH_FAQ_USER_MESSAGE,
} from '../pendingReservationDishFaq';

describe('pendingReservationDishFaq', () => {
  it('roundtrip y no cumple sin N', () => {
    const built = buildPendingReservationDishFaq({
      reason: 'sugerir platos para 6 por raciones',
      originalUserMessage: 'no sé qué platillos',
    });
    const got = getPendingReservationDishFaq({ pendingReservationDishFaq: built });
    expect(got?.reason).toBe('sugerir platos para 6 por raciones');
    expect(got?.originalUserMessage).toBe('no sé qué platillos');
    expect(
      shouldFulfillReservationDishFaq({ pending: got, partySize: undefined })
    ).toBe(false);
    expect(shouldFulfillReservationDishFaq({ pending: got, partySize: 6 })).toBe(
      true
    );
  });

  it('hybrid usa la consulta original; si falta, la canónica', () => {
    expect(
      dishFaqUserMessageForHybrid(
        buildPendingReservationDishFaq({
          reason: 'x',
          originalUserMessage: 'Quiero hacer una reserva Pero no sé que platillos',
        })
      )
    ).toMatch(/platillos/i);
    expect(
      dishFaqUserMessageForHybrid(buildPendingReservationDishFaq({ reason: 'x' }))
    ).toBe(CANONICAL_DISH_FAQ_USER_MESSAGE);
    expect(dishFaqDelegationReasonForPartySize(6)).toBe(
      'sugerir platos para 6 por raciones'
    );
  });

  it('ledger: con N el paso fecha no aplica', () => {
    const pending = buildPendingReservationDishFaq({
      reason: 'sugerir platos por raciones',
    });
    const withN = buildPendingReservationDishFaqContextLines({
      pendingReservationDishFaq: pending,
      reservation_draft: { partySize: 6 },
    });
    expect(withN.join('\n')).toMatch(/YA hay personas/);
    expect(withN.join('\n')).toMatch(/NO aplica este turno/);

    const withoutN = buildPendingReservationDishFaqContextLines({
      pendingReservationDishFaq: pending,
      reservation_draft: {},
    });
    expect(withoutN.join('\n')).toMatch(/Pedí personas/);
  });
});
