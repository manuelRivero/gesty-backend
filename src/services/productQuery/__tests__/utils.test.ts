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

  it('formatBotUserMessage no dobla asteriscos en el título', () => {
    const message = formatBotUserMessage('*Tu pedido*', '🛒', 'probá **pizza**');
    expect(message).toBe('🤖\n\n*Tu pedido* 🛒\n\nprobá *pizza*');
    expect(parseBotUserMessage(message)?.title).toBe('Tu pedido');
  });
});
