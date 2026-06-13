import { describe, expect, it } from 'vitest';
import {
  formatBotUserMessage,
  parseBotUserMessage,
  rebuildBotUserMessage,
} from '../utils';

describe('parseBotUserMessage', () => {
  it('extrae título, emoji y body del formato estándar', () => {
    const message = formatBotUserMessage(
      'Tu pedido',
      '🛒',
      'Agregamos 2× Pizza Margarita.'
    );

    expect(parseBotUserMessage(message)).toEqual({
      title: 'Tu pedido',
      emoji: '🛒',
      body: 'Agregamos 2× Pizza Margarita.',
    });
  });

  it('devuelve null si el texto no sigue el formato del bot', () => {
    expect(parseBotUserMessage('Hola, ¿en qué te ayudo?')).toBeNull();
  });

  it('rebuildBotUserMessage conserva título y emoji', () => {
    const rebuilt = rebuildBotUserMessage(
      'Reserva',
      '📋',
      'Contame para cuántos van a ser.'
    );

    expect(rebuilt).toBe(
      '🤖\n\n*Reserva* 📋\n\nContame para cuántos van a ser.'
    );
  });
});
