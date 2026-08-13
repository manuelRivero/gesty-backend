import { describe, it, expect } from 'vitest';
import { nextReservationStep } from '../nextReservationStep';

describe('nextReservationStep', () => {
  it('pide fecha si no hay draft', () => {
    expect(
      nextReservationStep(
        { date: null, slotId: null, partySize: null, environmentId: undefined },
        { hasEnvironments: false }
      )
    ).toBe('date');
  });

  it('pide horario cuando hay fecha pero no slotId (aunque haya time crudo)', () => {
    expect(
      nextReservationStep(
        { date: '20/08/2026', slotId: null, partySize: null, environmentId: undefined },
        { hasEnvironments: false }
      )
    ).toBe('slot');
  });

  it('pide personas cuando hay fecha y slot', () => {
    expect(
      nextReservationStep(
        { date: '20/08/2026', slotId: 'slot-1', partySize: null, environmentId: undefined },
        { hasEnvironments: false }
      )
    ).toBe('party_size');
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

  it('confirm cuando el draft está completo', () => {
    expect(
      nextReservationStep(
        { date: '20/08/2026', slotId: 'slot-1', partySize: 4, environmentId: 'env-1' },
        { hasEnvironments: true }
      )
    ).toBe('confirm');
  });
});
