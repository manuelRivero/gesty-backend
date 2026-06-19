import { describe, expect, it } from 'vitest';
import {
  BOT_PERSONALITY_SAMPLE_QUESTIONS,
  parseBotPersonalitySampleResponses,
} from '../botPersonalitySamples';

describe('botPersonalitySamples', () => {
  it('define las tres preguntas de preview', () => {
    expect(BOT_PERSONALITY_SAMPLE_QUESTIONS).toEqual([
      'Hola como están ?',
      'Quisiera hacer una reserva',
      'Quiero hacer un pedido',
    ]);
  });

  it('parsea sample_responses válidos', () => {
    const parsed = parseBotPersonalitySampleResponses([
      { question: 'Hola', response: '¡Hola!' },
      { question: ' ', response: 'x' },
      { question: 'Pedido', response: '' },
    ]);
    expect(parsed).toEqual([{ question: 'Hola', response: '¡Hola!' }]);
  });
});
