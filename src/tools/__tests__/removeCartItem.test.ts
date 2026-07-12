/**
 * Test del Constraint de ADR-0002 en remove_cart_item: la Tool no elimina
 * sin evidencia de confirmación previa, sin importar lo que el modelo diga.
 *
 * prisma y el repositorio de conversation_state se mockean para no requerir BD.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    draft_order_item: {
      findFirst: vi.fn(),
      delete: vi.fn(),
      aggregate: vi.fn(),
      findMany: vi.fn(),
    },
    conversation_state: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../repositories/conversationState.repository', () => ({
  patchConversationMetadata: vi.fn(),
  omitConversationMetadataKeys: vi.fn(),
}));

// tools/index.ts importa el módulo completo de tools (incluye MenuService, que
// instancia un cliente OpenAI al cargar) — se mockea para no requerir API keys.
vi.mock('../../services/menu.service', () => ({
  MenuService: {},
}));

import { removeCartItemTool } from '../index';
import { prisma } from '../../lib/prisma';
import {
  patchConversationMetadata,
  omitConversationMetadataKeys,
} from '../../repositories/conversationState.repository';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

const DRAFT = { id: 'draft-1' };
const PRODUCT_ID = '11111111-1111-1111-1111-111111111111';
const LINE = {
  id: 'line-1',
  quantity: 2,
  menu_item: { id: PRODUCT_ID, name: 'Milanesa' },
};

const callTool = (input: { productId: string }) =>
  removeCartItemTool.func(input, undefined, CONFIG);

describe('remove_cart_item — Constraint de confirmación (ADR-0002)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(DRAFT as never);
    vi.mocked(prisma.draft_order_item.findFirst).mockResolvedValue(LINE as never);
  });

  it('no elimina el ítem en el primer llamado, sin confirmación previa', async () => {
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({ metadata: {} } as never);

    const raw = await callTool({ productId: PRODUCT_ID });
    const result = JSON.parse(raw as string);

    expect(result.success).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(prisma.draft_order_item.delete).not.toHaveBeenCalled();
    expect(patchConversationMetadata).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        pending_item_removal: expect.objectContaining({ productId: PRODUCT_ID }),
      })
    );
  });

  it('elimina el ítem cuando hay un pending previo vigente para el mismo productId', async () => {
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: {
        pending_item_removal: { productId: PRODUCT_ID, requestedAt: new Date().toISOString() },
      },
    } as never);
    vi.mocked(prisma.draft_order_item.aggregate).mockResolvedValue({
      _sum: { total_price: null },
    } as never);
    vi.mocked(prisma.draft_order_item.findMany).mockResolvedValue([] as never);

    const raw = await callTool({ productId: PRODUCT_ID });
    const result = JSON.parse(raw as string);

    expect(result.success).toBe(true);
    expect(prisma.draft_order_item.delete).toHaveBeenCalledWith({ where: { id: 'line-1' } });
    expect(omitConversationMetadataKeys).toHaveBeenCalledWith('conv-1', ['pending_item_removal']);
  });

  it('no elimina si el pending previo es de otro productId', async () => {
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: {
        pending_item_removal: {
          productId: '22222222-2222-2222-2222-222222222222',
          requestedAt: new Date().toISOString(),
        },
      },
    } as never);

    const raw = await callTool({ productId: PRODUCT_ID });
    const result = JSON.parse(raw as string);

    expect(result.success).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(prisma.draft_order_item.delete).not.toHaveBeenCalled();
  });

  it('no elimina si el pending previo expiró (TTL vencido)', async () => {
    const expired = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min > 5 min TTL
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: { pending_item_removal: { productId: PRODUCT_ID, requestedAt: expired } },
    } as never);

    const raw = await callTool({ productId: PRODUCT_ID });
    const result = JSON.parse(raw as string);

    expect(result.success).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(prisma.draft_order_item.delete).not.toHaveBeenCalled();
  });
});
