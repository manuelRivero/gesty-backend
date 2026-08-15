import { describe, expect, it } from 'vitest';
import {
  formatBotUserMessage,
  parseBotUserMessage,
  rebuildBotUserMessage,
  ensureBotUserMessageFormat,
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

describe('ensureBotUserMessageFormat', () => {
  it('envuelve prosa suelta con título y emoji', () => {
    const out = ensureBotUserMessageFormat(
      '¡Hola! Decime tu nombre.',
      'Bienvenida',
      '👋',
      'fallback'
    );
    expect(out).toBe(
      formatBotUserMessage('Bienvenida', '👋', '¡Hola! Decime tu nombre.')
    );
  });

  it('normaliza un 🤖 incompleto sin título parseable', () => {
    const out = ensureBotUserMessageFormat(
      '🤖\n\nHola sin título',
      'Bienvenida',
      '👋',
      'fallback'
    );
    expect(parseBotUserMessage(out)).toEqual({
      title: 'Bienvenida',
      emoji: '👋',
      body: 'Hola sin título',
    });
  });

  it('respeta un mensaje ya bien formado', () => {
    const original = formatBotUserMessage('Saludo', '👋', 'Cuerpo ok');
    expect(ensureBotUserMessageFormat(original, 'X', '📍', 'fb')).toBe(original);
  });
});
