import { describe, expect, it } from 'vitest';
import {
  buildReservationFaqDelegation,
  buildReservationFaqDelegationContextLines,
  getReservationFaqDelegation,
  isReservationFaqMode,
  ORDER_PUSH_INTENTS_DURING_RESERVATION_FAQ,
} from '../reservationFaqDelegation.service';

describe('reservationFaqDelegation.service', () => {
  it('build/get roundtrip con reason', () => {
    const built = buildReservationFaqDelegation('consulta de raciones');
    expect(built.reason).toBe('consulta de raciones');
    expect(built.delegatedAt).toMatch(/^\d{4}-/);

    const got = getReservationFaqDelegation({
      reservation_faq_delegation: built,
    });
    expect(got).toEqual(built);
  });

  it('get rechaza payload inválido', () => {
    expect(getReservationFaqDelegation({})).toBeNull();
    expect(
      getReservationFaqDelegation({ reservation_faq_delegation: { reason: 'x' } })
    ).toBeNull();
  });

  it('isReservationFaqMode: Fact o sesión activa', () => {
    expect(isReservationFaqMode({})).toBe(false);
    expect(
      isReservationFaqMode({
        reservation_faq_delegation: buildReservationFaqDelegation(),
      })
    ).toBe(true);
    expect(isReservationFaqMode({ reservation_agent_active: true })).toBe(true);
  });

  it('ledger declara FAQ + mesa del draft (no pedido)', () => {
    const lines = buildReservationFaqDelegationContextLines({
      reservation_faq_delegation: buildReservationFaqDelegation('menú'),
      reservation_draft: { partySize: 10 },
    });
    expect(lines.join('\n')).toMatch(/Delegación FAQ mid-reserva: activa/);
    expect(lines.join('\n')).toMatch(/no ofrezcas sumar platos al pedido/i);
    expect(lines.join('\n')).toMatch(/Mesa en borrador: 10 personas/);
    expect(lines.join('\n')).toMatch(/NO son personas del pedido/i);
  });

  it('ORDER_PUSH_INTENTS cubre Goals/Opportunities de pedido', () => {
    expect(ORDER_PUSH_INTENTS_DURING_RESERVATION_FAQ.has('COMPLETAR_PEDIDO')).toBe(
      true
    );
    expect(
      ORDER_PUSH_INTENTS_DURING_RESERVATION_FAQ.has('OBTENER_PERSONAS_DEL_PEDIDO')
    ).toBe(true);
    expect(ORDER_PUSH_INTENTS_DURING_RESERVATION_FAQ.has('COMPLETAR_RESERVA')).toBe(
      false
    );
  });
});
