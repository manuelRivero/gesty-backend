import { describe, it, expect } from 'vitest';
import { nextReservationStep } from '../nextReservationStep';

describe('nextReservationStep', () => {
  it('pide personas si no hay draft', () => {
    expect(
      nextReservationStep(
        { date: null, slotId: null, partySize: null, environmentId: undefined },
        { hasEnvironments: false }
      )
    ).toBe('party_size');
  });

  it('pide fecha cuando hay personas pero no fecha', () => {
    expect(
      nextReservationStep(
        { date: null, slotId: null, partySize: 6, environmentId: undefined },
        { hasEnvironments: false }
      )
    ).toBe('date');
  });

  it('pide horario cuando hay personas y fecha pero no slotId', () => {
    expect(
      nextReservationStep(
        { date: '20/08/2026', slotId: null, partySize: 4, environmentId: undefined },
        { hasEnvironments: false }
      )
    ).toBe('slot');
  });

  it('no pide personas si ya están aunque falte fecha', () => {
    expect(
      nextReservationStep(
        { date: null, slotId: null, partySize: 2, environmentId: undefined },
        { hasEnvironments: false }
      )
    ).toBe('date');
  });

  it('pide ambiente solo si el negocio tiene ambientes configurados', () => {
    expect(
      nextReservationStep(
        { date: '20/08/2026', slotId: 'slot-1', partySize: 4, environmentId: undefined },
        { hasEnvironments: true }
      )
    ).toBe('environment');

    expect(
      nextReservationStep(
        { date: '20/08/2026', slotId: 'slot-1', partySize: 4, environmentId: undefined },
        { hasEnvironments: false }
      )
    ).toBe('confirm');
  });

  it('environmentId: null ("sin preferencia") cuenta como elegido', () => {
    expect(
      nextReservationStep(
        { date: '20/08/2026', slotId: 'slot-1', partySize: 4, environmentId: null },
        { hasEnvironments: true }
      )
    ).toBe('confirm');
  });
});
