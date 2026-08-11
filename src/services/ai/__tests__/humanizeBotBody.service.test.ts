import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatBotUserMessage } from '../../productQuery/utils';
import { ConversationIntent } from '../../../types/conversationIntent';

const invokeMock = vi.fn();

vi.mock('../../../config/llm', () => ({
  getSmallChatLlm: () => ({ invoke: invokeMock }),
}));

import { humanizeHandlerResult } from '../humanizeBotBody.service';

describe('humanizeHandlerResult', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({
      content: '¡Listo! Te sumé la pizza al carrito.',
    });
  });

  it('no humaniza si el flag del negocio está apagado', async () => {
    const original = formatBotUserMessage('Pedido', '🛒', 'Producto agregado.');

    const result = await humanizeHandlerResult(
      { content: original, isInteractive: false },
      { enabled: false }
    );

    expect(result.content).toBe(original);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('humaniza solo el body cuando está habilitado', async () => {
    const original = formatBotUserMessage('Pedido', '🛒', 'Producto agregado.');

    const result = await humanizeHandlerResult(
      { content: original, isInteractive: false },
      { enabled: true, intent: ConversationIntent.ADD_ITEM }
    );

    expect(result.content).toBe(
      formatBotUserMessage('Pedido', '🛒', '¡Listo! Te sumé la pizza al carrito.')
    );
    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it('respeta skipBodyHumanization', async () => {
    const original = formatBotUserMessage('Respuesta', '💬', 'Texto del agente.');

    const result = await humanizeHandlerResult(
      {
        content: original,
        isInteractive: false,
        skipBodyHumanization: true,
      },
      { enabled: true }
    );

    expect(result.content).toBe(original);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('omite intents con body generado por LLM', async () => {
    const original = formatBotUserMessage('Info', '🍽️', 'Descripción del plato.');

    const result = await humanizeHandlerResult(
      { content: original, isInteractive: false },
      { enabled: true, intent: ConversationIntent.PRODUCT_QUERY }
    );

    expect(result.content).toBe(original);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('humaniza body plano de lista (sin encabezado 🤖) y conserva el content interactivo', async () => {
    invokeMock.mockResolvedValue({
      content:
        'Escribí una categoría o el plato que querés:\n\n' +
        '• *Bebidas frías*\n' +
        '• *Platos principales*',
    });

    const listBody =
      'Escribí una categoría o el nombre del plato que querés:\n\n' +
      '• *Bebidas frías*\n' +
      '• *Platos principales*';

    const original = {
      type: 'list' as const,
      header: { type: 'text' as const, text: '🤖\n\n*Este es nuestro menú* 🍲' },
      body: { text: listBody },
      footer: { text: 'Página 1' },
      action: {
        button: 'Ver categorías',
        sections: [{ title: 'Categorías', rows: [] }],
      },
    };

    const result = await humanizeHandlerResult(
      { content: original, isInteractive: true },
      { enabled: true, intent: ConversationIntent.VIEW_MENU }
    );

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(result.isInteractive).toBe(true);
    const content = result.content as typeof original;
    expect(content.header.text).toBe(original.header.text);
    expect(content.body.text).toContain('*Bebidas frías*');
    expect(content.body.text).toContain('*Platos principales*');
    expect(content.body.text).toContain('•');
  });
});
