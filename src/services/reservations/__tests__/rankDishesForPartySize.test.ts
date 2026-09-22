import { describe, expect, it } from 'vitest';
import {
  classifyDishForPartySize,
  instructionForDishPartyRanking,
  rankDishesForReservationPartySize,
} from '../rankDishesForPartySize';

describe('rankDishesForReservationPartySize', () => {
  it('exact gana a near; no mezcla cover si hay exact/near', () => {
    const ranked = rankDishesForReservationPartySize(
      [
        { id: '8', name: 'Parrillada 8', serves_people: 8 },
        { id: '6', name: 'Pollo 6', serves_people: 6, is_featured: true },
        { id: '2', name: 'Entrada 2', serves_people: 2 },
      ],
      6,
      10
    );
    expect(ranked.map((d) => d.id)).toEqual(['6', '8']);
    expect(ranked[0].match).toBe('exact');
    expect(ranked[1].match).toBe('near');
  });

  it('sin exact/near: cover con ceil(N/serves) — mesa de 3, plato de 2', () => {
    const two = classifyDishForPartySize(2, 3);
    expect(two.match).toBe('cover');
    expect(two.suggestedUnits).toBe(2);
    expect(two.covers).toBe(4);
    expect(two.note).toBe('ración para: 2');

    const ranked = rankDishesForReservationPartySize(
      [
        { id: '2', name: 'Milanesa 2', serves_people: 2 },
        { id: '1', name: 'Ensalada 1', serves_people: 1 },
        { id: '8', name: 'Parrillada 8', serves_people: 8 },
      ],
      3,
      10
    );
    expect(ranked.every((d) => d.match === 'cover')).toBe(true);
    expect(ranked[0].id).toBe('2');
    expect(ranked[0].suggestedUnits).toBe(2);
    expect(ranked[0].displayLine).toBe('• *Milanesa 2*\nración para: 2');
    expect(ranked.some((d) => d.id === '8')).toBe(false);
  });

  it('solo over si no hay nada que cubra', () => {
    const ranked = rankDishesForReservationPartySize(
      [{ id: '10', name: 'Banquete', serves_people: 10 }],
      3,
      5
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0].match).toBe('over');
  });

  it('instruction cover no dice que no hay platos', () => {
    const text = instructionForDishPartyRanking({
      count: 2,
      bestMatch: 'cover',
      reservationActive: false,
    });
    expect(text).toMatch(/displayLine/);
    expect(text).toMatch(/ración para/);
    expect(text).toMatch(/PROHIBIDO copiar suggestedUnits/);
    expect(text).not.toMatch(/No hay platos/);
  });

  it('instruction cover con reserva activa: sin frase de unidades y sin cierre propio', () => {
    const text = instructionForDishPartyRanking({
      count: 2,
      bestMatch: 'cover',
      reservationActive: true,
    });
    expect(text).toMatch(/PROHIBIDO agregar la frase de unidades/);
    expect(text).toMatch(/PROHIBIDO cerrar con una pregunta/);
    expect(text).not.toMatch(/Después de la lista, UNA frase como en pedido/);
  });

  it('instruction sin platos con reserva activa: no ofrece seguir la reserva', () => {
    const text = instructionForDishPartyRanking({
      count: 0,
      bestMatch: 'none',
      reservationActive: true,
    });
    expect(text).toMatch(/No hay platos con ración cargada/);
    expect(text).not.toMatch(/o seguir la reserva/);
    expect(text).toMatch(/PROHIBIDO cerrar con una pregunta/);
  });
});
