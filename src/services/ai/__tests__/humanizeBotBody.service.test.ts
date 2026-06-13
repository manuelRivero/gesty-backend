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
});
