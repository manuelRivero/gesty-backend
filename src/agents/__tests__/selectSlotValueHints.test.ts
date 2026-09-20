import { describe, expect, it } from 'vitest';
import {
  buildSelectEnvironmentValueHints,
  buildSelectSlotValueHints,
} from '../reservationAgent';

describe('buildSelectSlotValueHints', () => {
  it('incluye bandas mediodía/tarde/noche y uuids del catálogo', () => {
    const { valueHints, actionDescription } = buildSelectSlotValueHints([
      { id: 'slot-day', startTime: '13:00', endTime: '14:30' },
      { id: 'slot-night', startTime: '20:00', endTime: '21:30' },
    ]);

    expect(valueHints).toMatch(/a la noche/);
    expect(valueHints).toMatch(/mediodía/);
    expect(valueHints).toMatch(/19:00–23:59/);
    expect(valueHints).toContain('slot-day');
    expect(valueHints).toContain('slot-night');
    expect(actionDescription).toMatch(/banda/i);
  });
});

describe('buildSelectEnvironmentValueHints', () => {
  it('instruye no fulfilled ante ambiente inexistente (carpa)', () => {
    const { valueHints, actionDescription } = buildSelectEnvironmentValueHints([
      { id: 'env-1', name: 'Salón principal' },
      { id: 'env-2', name: 'Patio exterior' },
    ]);
    expect(valueHints).toMatch(/carpa cerca de los juegos/i);
    expect(valueHints).toMatch(/NO inventes uuid/i);
    expect(valueHints).toMatch(/Match parcial/i);
    expect(actionDescription).toMatch(/inexistente/i);
  });
});
