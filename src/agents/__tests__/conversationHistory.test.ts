import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';

const findRecentMock = vi.fn();

vi.mock('../../repositories', () => ({
  findRecentMessagesForDetectionContext: (...args: unknown[]) =>
    findRecentMock(...args),
}));

import { buildAgentHistoryMessages } from '../conversationHistory';

/** Helper para armar filas como las devuelve el repo (orden desc: más nuevo primero). */
const row = (sender: string, message: string, externalMessageId?: string) => ({
  sender,
  message,
  externalMessageId: externalMessageId ?? null,
});

describe('buildAgentHistoryMessages', () => {
  beforeEach(() => {
    findRecentMock.mockReset();
  });

  it('devuelve [] sin conversationId', async () => {
    const result = await buildAgentHistoryMessages({ conversationId: '' });
    expect(result).toEqual([]);
    expect(findRecentMock).not.toHaveBeenCalled();
  });

  it('mapea sender→rol y ordena cronológicamente (invierte el desc del repo)', async () => {
    // Repo devuelve desc: más nuevo primero.
    findRecentMock.mockResolvedValue([
      row('ai', '¿Querés saber más?'),
      row('user', 'que onda con el ceviche?'),
      row('ai', '¡Hola! ¿En qué te ayudo?'),
    ]);

    const result = await buildAgentHistoryMessages({ conversationId: 'c1' });

    expect(result).toHaveLength(3);
    // Orden cronológico: el más viejo primero.
    expect(result[0]).toBeInstanceOf(AIMessage);
    expect(result[0].content).toBe('¡Hola! ¿En qué te ayudo?');
    expect(result[1]).toBeInstanceOf(HumanMessage);
    expect(result[1].content).toBe('que onda con el ceviche?');
    expect(result[2]).toBeInstanceOf(AIMessage);
    expect(result[2].content).toBe('¿Querés saber más?');
  });

  it('excluye el turno actual por externalMessageId (no lo duplica)', async () => {
    findRecentMock.mockResolvedValue([
      row('user', 'Si', 'wamid.CURRENT'),
      row('ai', '¿Querés saber más?'),
      row('user', 'que onda con el ceviche?', 'wamid.PREV'),
    ]);

    const result = await buildAgentHistoryMessages({
      conversationId: 'c1',
      currentMessageId: 'wamid.CURRENT',
    });

    expect(result).toHaveLength(2);
    expect(result.map((m) => m.content)).toEqual([
      'que onda con el ceviche?',
      '¿Querés saber más?',
    ]);
    expect(result.some((m) => m.content === 'Si')).toBe(false);
  });

  it('pide limit+1 al repo y recorta a los `limit` más recientes tras excluir el actual', async () => {
    findRecentMock.mockResolvedValue([
      row('user', 'm5'),
      row('ai', 'm4'),
      row('user', 'm3'),
      row('ai', 'm2'),
      row('user', 'm1'),
    ]);

    const result = await buildAgentHistoryMessages({
      conversationId: 'c1',
      limit: 3,
    });

    expect(findRecentMock).toHaveBeenCalledWith('c1', expect.any(Date), 4);
    // Los 3 más recientes en orden cronológico.
    expect(result.map((m) => m.content)).toEqual(['m3', 'm4', 'm5']);
  });

  it('descarta mensajes vacíos', async () => {
    findRecentMock.mockResolvedValue([
      row('ai', '   '),
      row('user', 'hola'),
    ]);

    const result = await buildAgentHistoryMessages({ conversationId: 'c1' });

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('hola');
  });

  it('ante un error del repo devuelve [] (no rompe el turno)', async () => {
    findRecentMock.mockRejectedValue(new Error('db down'));
    const result = await buildAgentHistoryMessages({ conversationId: 'c1' });
    expect(result).toEqual([]);
  });
});
