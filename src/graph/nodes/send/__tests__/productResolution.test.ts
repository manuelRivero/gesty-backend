import { describe, expect, it, vi } from 'vitest';

const { issueProductResolutionsMock, sendResponseMock, conversationMetadata } = vi.hoisted(() => ({
  issueProductResolutionsMock: vi.fn().mockResolvedValue([]),
  sendResponseMock: vi.fn().mockResolvedValue(undefined),
  conversationMetadata: { current: {} as Record<string, unknown> },
}));

vi.mock('../../../../controllers/webhook/sender', () => ({
  sendResponse: sendResponseMock,
}));
vi.mock('../../../../config/env', () => ({
  isDryRunWhatsAppSend: () => false,
}));
vi.mock('../../../../services/ai/humanizeBotBody.service', () => ({
  humanizeHandlerResult: vi.fn(async (result: unknown) => result),
}));
vi.mock('../../../../services/productResolution.service', () => ({
  issueProductResolutions: issueProductResolutionsMock,
}));
vi.mock('../../../../repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../repositories')>();
  return {
    ...actual,
    findOrCreateConversationState: vi.fn(async () => ({ metadata: conversationMetadata.current })),
  };
});

import { sendResponseNode } from '../index';

const BUSINESS_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONVERSATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MENU_ITEM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const QUERY_ITEM_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('sendResponseNode ProductResolution issuance', () => {
  it('registra como candidates los productos incluidos en botones/listas enviados', async () => {
    const result = {
      content: {
        type: 'list',
        action: {
          sections: [{
            title: 'Productos',
            rows: [
              { id: `ADD_ITEM:${MENU_ITEM_ID}:1`, title: 'Menú' },
              { id: `SELECT_PRODUCT:${QUERY_ITEM_ID}`, title: 'Resultado' },
              { id: 'VIEW_MENU', title: 'Menú completo' },
            ],
          }],
        },
      },
      isInteractive: true,
    };

    await sendResponseNode({
      webhookContext: { to: '+5491100000000' },
      handlerResult: result,
      business: { id: BUSINESS_ID },
      conversation: { id: CONVERSATION_ID },
      businessConfig: { humanize_messages: false },
    } as never);

    expect(sendResponseMock).toHaveBeenCalledOnce();
    expect(issueProductResolutionsMock).toHaveBeenCalledWith({
      productIds: [MENU_ITEM_ID, QUERY_ITEM_ID],
      businessId: BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      source: 'whatsapp_presentation',
      status: 'candidate',
      scope: 'conversation',
    });
  });

  it('usa provenance complement para los candidatos de una ola de complemento', async () => {
    conversationMetadata.current = {
      pendingComplementSelection: true,
      candidateProductIds: [MENU_ITEM_ID],
    };
    const result = {
      content: {
        type: 'list',
        action: {
          sections: [{ rows: [{ id: `ADD_ITEM:${MENU_ITEM_ID}:1`, title: 'Complemento' }] }],
        },
      },
      isInteractive: true,
    };

    await sendResponseNode({
      webhookContext: { to: '+5491100000000' },
      handlerResult: result,
      business: { id: BUSINESS_ID },
      conversation: { id: CONVERSATION_ID },
      businessConfig: { humanize_messages: false },
    } as never);

    expect(issueProductResolutionsMock).toHaveBeenCalledWith({
      productIds: [MENU_ITEM_ID],
      businessId: BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      source: 'complement',
      status: 'candidate',
      scope: 'conversation',
    });
  });
});