/**
 * Test del Constraint de ADR-0002 en remove_cart_item: la Tool no elimina
 * sin evidencia de confirmación previa, sin importar lo que el modelo diga.
 *
 * La evidencia (`pendingAction`/`pendingItemId`) es la MISMA clave que usa
 * el flujo determinístico de botones (`cart.service.ts`)
 * — así cualquiera de los dos caminos que preguntó primero sirve de evidencia
 * para el otro, sin duplicar el estado de "¿ya se preguntó por este ítem?".
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
const LINE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_LINE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const LINE = {
  id: LINE_ID,
  product_id: PRODUCT_ID,
  variation: null,
  quantity: 2,
  menu_item: { id: PRODUCT_ID, name: 'Milanesa' },
};

const callTool = (input: { productId?: string; draftOrderItemId?: string }) =>
  removeCartItemTool.func(input, undefined, CONFIG);

describe('remove_cart_item — Constraint de confirmación (ADR-0002)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(DRAFT as never);
    vi.mocked(prisma.draft_order_item.findMany).mockResolvedValue([LINE] as never);
  });

  it('no elimina el ítem en el primer llamado, sin confirmación previa', async () => {
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({ metadata: {} } as never);

    const raw = await callTool({ productId: PRODUCT_ID });
    const result = JSON.parse(raw as string);

    expect(result.success).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(prisma.draft_order_item.delete).not.toHaveBeenCalled();
    expect(patchConversationMetadata).toHaveBeenCalledWith('conv-1', {
      pendingAction: 'CONFIRM_REMOVE',
      pendingItemId: LINE_ID,
      pendingItemName: 'Milanesa',
      pendingActionAt: expect.any(String),
    });
  });

  it('elimina el ítem cuando hay un pending previo vigente para el mismo productId', async () => {
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: {
        pendingAction: 'CONFIRM_REMOVE',
        pendingItemId: LINE_ID,
        pendingActionAt: new Date().toISOString(),
      },
    } as never);
    vi.mocked(prisma.draft_order_item.aggregate).mockResolvedValue({
      _sum: { total_price: null },
    } as never);
    // findMany atiende dos consultas: primero los candidatos, después el
    // snapshot del carrito ya sin la línea borrada.
    vi.mocked(prisma.draft_order_item.findMany)
      .mockResolvedValueOnce([LINE] as never)
      .mockResolvedValueOnce([] as never);

    const raw = await callTool({ productId: PRODUCT_ID });
    const result = JSON.parse(raw as string);

    expect(result.success).toBe(true);
    expect(prisma.draft_order_item.delete).toHaveBeenCalledWith({ where: { id: LINE_ID } });
    expect(omitConversationMetadataKeys).toHaveBeenCalledWith('conv-1', [
      'pendingAction',
      'pendingItemId',
      'pendingItemName',
      'pendingActionAt',
    ]);
  });

  it('elimina directo cuando el pending lo dejó el flujo determinístico de botones', async () => {
    // Reproduce el bug real: el handler de botón (cart.service.ts) ya mostró la
    // confirmación por botones y dejó pendingAction/pendingItemId en metadata.
    // El cliente responde en texto libre ("sí") en vez de tocar el botón, el
    // híbrido llama esta Tool — antes de la unificación, la Tool no sabía nada
    // de ese pending y volvía a preguntar por su cuenta.
    // Un pending dejado ANTES del deploy guarda el product_id, no el id de
    // línea: tiene que seguir siendo evidencia válida.
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: {
        pendingAction: 'CONFIRM_REMOVE',
        pendingItemId: PRODUCT_ID,
        pendingItemName: 'Milanesa',
        pendingActionAt: new Date().toISOString(),
      },
    } as never);
    vi.mocked(prisma.draft_order_item.aggregate).mockResolvedValue({
      _sum: { total_price: null },
    } as never);
    // findMany atiende dos consultas: primero los candidatos, después el
    // snapshot del carrito ya sin la línea borrada.
    vi.mocked(prisma.draft_order_item.findMany)
      .mockResolvedValueOnce([LINE] as never)
      .mockResolvedValueOnce([] as never);

    const raw = await callTool({ productId: PRODUCT_ID });
    const result = JSON.parse(raw as string);

    expect(result.success).toBe(true);
    expect(prisma.draft_order_item.delete).toHaveBeenCalled();
  });

  it('no elimina si el pending previo es de otro productId', async () => {
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: {
        pendingAction: 'CONFIRM_REMOVE',
        pendingItemId: '22222222-2222-2222-2222-222222222222',
        pendingActionAt: new Date().toISOString(),
      },
    } as never);

    const raw = await callTool({ productId: PRODUCT_ID });
    const result = JSON.parse(raw as string);

    expect(result.success).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(prisma.draft_order_item.delete).not.toHaveBeenCalled();
  });

  it('no elimina si el pendingAction es de otro tipo (ej. EDIT_CART)', async () => {
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: {
        pendingAction: 'EDIT_CART',
        pendingItemId: LINE_ID,
        pendingActionAt: new Date().toISOString(),
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
      metadata: {
        pendingAction: 'CONFIRM_REMOVE',
        pendingItemId: LINE_ID,
        pendingActionAt: expired,
      },
    } as never);

    const raw = await callTool({ productId: PRODUCT_ID });
    const result = JSON.parse(raw as string);

    expect(result.success).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    expect(prisma.draft_order_item.delete).not.toHaveBeenCalled();
  });
});

/**
 * Con variaciones un producto ocupa varias líneas: borrar "la primera que
 * devuelva la query" elimina una arbitraria. Mismo contrato que
 * `update_item_note`: candidatos, no adivinanza.
 */
describe('remove_cart_item — varias líneas del mismo plato (variaciones)', () => {
  const ESPECIAL = { ...LINE, id: LINE_ID, variation: 'Especial' };
  const ROQUEFORT = { ...LINE, id: OTHER_LINE_ID, variation: 'Roquefort' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(DRAFT as never);
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({ metadata: {} } as never);
  });

  it('con solo productId y dos líneas devuelve los candidatos sin borrar ni preguntar por una', async () => {
    vi.mocked(prisma.draft_order_item.findMany).mockResolvedValue([ESPECIAL, ROQUEFORT] as never);

    const result = JSON.parse((await callTool({ productId: PRODUCT_ID })) as string);

    expect(result.success).toBe(false);
    expect(result.error).toBe('ambiguous_lines');
    expect(result.candidates).toEqual([
      {
        draftOrderItemId: LINE_ID,
        productId: PRODUCT_ID,
        name: 'Milanesa',
        variation: 'Especial',
        quantity: 2,
      },
      {
        draftOrderItemId: OTHER_LINE_ID,
        productId: PRODUCT_ID,
        name: 'Milanesa',
        variation: 'Roquefort',
        quantity: 2,
      },
    ]);
    expect(prisma.draft_order_item.delete).not.toHaveBeenCalled();
    // No deja pending: todavía no se sabe por cuál ítem preguntar.
    expect(patchConversationMetadata).not.toHaveBeenCalled();
  });

  it('con draftOrderItemId apunta a esa línea y nombra la variación al pedir confirmación', async () => {
    vi.mocked(prisma.draft_order_item.findMany).mockResolvedValue([ROQUEFORT] as never);

    const result = JSON.parse((await callTool({ draftOrderItemId: OTHER_LINE_ID })) as string);

    expect(result.requiresConfirmation).toBe(true);
    expect(result.item).toEqual({
      draftOrderItemId: OTHER_LINE_ID,
      productId: PRODUCT_ID,
      itemName: 'Milanesa (Roquefort)',
      quantity: 2,
    });
    expect(patchConversationMetadata).toHaveBeenCalledWith('conv-1', {
      pendingAction: 'CONFIRM_REMOVE',
      pendingItemId: OTHER_LINE_ID,
      pendingItemName: 'Milanesa (Roquefort)',
      pendingActionAt: expect.any(String),
    });
  });

  it('confirmada una línea, borra esa y no la otra variación', async () => {
    vi.mocked(prisma.draft_order_item.findMany)
      .mockResolvedValueOnce([ROQUEFORT] as never)
      .mockResolvedValueOnce([ESPECIAL] as never);
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: {
        pendingAction: 'CONFIRM_REMOVE',
        pendingItemId: OTHER_LINE_ID,
        pendingActionAt: new Date().toISOString(),
      },
    } as never);
    vi.mocked(prisma.draft_order_item.aggregate).mockResolvedValue({
      _sum: { total_price: null },
    } as never);

    const result = JSON.parse((await callTool({ draftOrderItemId: OTHER_LINE_ID })) as string);

    expect(result.success).toBe(true);
    expect(result.removed.itemName).toBe('Milanesa (Roquefort)');
    expect(prisma.draft_order_item.delete).toHaveBeenCalledWith({ where: { id: OTHER_LINE_ID } });
  });
});
