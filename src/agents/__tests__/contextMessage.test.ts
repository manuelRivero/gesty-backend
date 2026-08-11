/**
 * Tests de `buildContextMessage` (Tarea 1.3 de PLAN-ACCION-CALIDAD-CONVERSACIONAL.md).
 *
 * Cubre los casos de tabla del plan: carrito inexistente, carrito vacío,
 * carrito con ítems, checkout activo y oferta activa. En todos los casos sin
 * motivo para hablar del carrito, la línea "- Carrito:" no debe aparecer
 * (síntoma 1: repetición del estado del carrito).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: {
      findFirst: vi.fn(),
    },
    menu_item: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    payment_intent: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    conversation_state: {
      findUnique: vi.fn().mockResolvedValue({ metadata: {} }),
    },
  },
}));

vi.mock('../../repositories/reservation.repository', () => ({
  findActiveEnvironmentsByBusinessId: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../repositories', () => ({
  patchConversationMetadata: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../helpers/complementaryMenu.helper', async () => {
  const actual = await vi.importActual<typeof import('../../helpers/complementaryMenu.helper')>(
    '../../helpers/complementaryMenu.helper'
  );
  return {
    ...actual,
    collectCategoryTagsInDraftCart: vi.fn().mockResolvedValue(new Set()),
  };
});

vi.mock('../../services/complementSuggestions.service', () => ({
  canSurfaceComplementOpportunity: vi.fn().mockReturnValue(false),
}));

import { buildContextMessage } from '../contextMessage';
import { prisma } from '../../lib/prisma';
import type { EnrichedContext } from '../../controllers/webhook/types';

const findFirstMock = prisma.draft_order.findFirst as unknown as ReturnType<typeof vi.fn>;
const menuFindManyMock = prisma.menu_item.findMany as unknown as ReturnType<typeof vi.fn>;

const makeCtx = (
  overrides: {
    metadata?: Record<string, unknown>;
    userMsg?: string;
    partySizeJustConfirmed?: number;
  } = {}
): EnrichedContext =>
  ({
    business: { id: 'biz-1' },
    customer: { id: 'cust-1', phone_number: '51999000000' },
    conversation: { id: 'conv-1', started_at: new Date() },
    conversationState: { metadata: overrides.metadata ?? {} },
    conversationId: 'conv-1',
    message: { text: { body: overrides.userMsg ?? '¿Tienen descuentos?' }, type: 'text' },
    to: '51999000000',
    detection: null,
    partySizeJustConfirmed: overrides.partySizeJustConfirmed,
  }) as unknown as EnrichedContext;

describe('buildContextMessage', () => {
  beforeEach(() => {
    findFirstMock.mockReset();
    menuFindManyMock.mockReset();
    menuFindManyMock.mockResolvedValue([]);
  });

  it('carrito inexistente: no menciona "Carrito"', async () => {
    findFirstMock.mockResolvedValue(null);
    const msg = await buildContextMessage(makeCtx());
    expect(msg).not.toContain('Carrito');
  });

  it('carrito vacío (draft activo sin ítems): no menciona "Carrito"', async () => {
    findFirstMock.mockResolvedValue({
      id: 'draft-1',
      fulfillment_type: null,
      expires_at: null,
      _count: { draft_order_item: 0 },
    });
    const msg = await buildContextMessage(makeCtx());
    expect(msg).not.toContain('Carrito');
  });

  it('carrito con ítems: menciona "Carrito" con la cantidad', async () => {
    findFirstMock.mockResolvedValue({
      id: 'draft-1',
      fulfillment_type: null,
      expires_at: null,
      _count: { draft_order_item: 2 },
    });
    const msg = await buildContextMessage(makeCtx());
    expect(msg).toContain('- Carrito: 2 ítem(s) en carrito');
  });

  it('checkout activo sin ítems: menciona "Carrito" y "Sesión de checkout: activa"', async () => {
    findFirstMock.mockResolvedValue(null);
    const msg = await buildContextMessage(makeCtx({ metadata: { checkout_active: true } }));
    expect(msg).toContain('- Carrito:');
    expect(msg).toContain('- Sesión de checkout: activa');
  });

  it('oferta activa sin carrito: menciona "Carrito" por la oferta pendiente', async () => {
    findFirstMock.mockResolvedValue(null);
    const msg = await buildContextMessage(
      makeCtx({
        metadata: {
          lastOffer: {
            kind: 'ADD_ITEM',
            productId: 'prod-1',
            productName: 'Ceviche',
            suggestedQuantity: 1,
            offeredAt: new Date().toISOString(),
            source: 'product_focus',
          },
        },
      })
    );
    expect(msg).toContain('- Carrito:');
    expect(msg).toContain('Oferta activa');
  });

  it('sin checkout activo, no incluye la línea de "Sesión de checkout"', async () => {
    findFirstMock.mockResolvedValue(null);
    const msg = await buildContextMessage(makeCtx());
    expect(msg).not.toContain('Sesión de checkout');
  });

  it('siempre incluye el mensaje del usuario al final', async () => {
    findFirstMock.mockResolvedValue(null);
    const msg = await buildContextMessage(makeCtx({ userMsg: '¿Cómo estás?' }));
    expect(msg.endsWith('¿Cómo estás?')).toBe(true);
  });

  it('ambos Goals abiertos: inyecta UNA sola línea de Goal (pedido gana) — A.4 / ADR-0009', async () => {
    findFirstMock.mockResolvedValue({
      id: 'draft-1',
      fulfillment_type: null,
      expires_at: null,
      _count: { draft_order_item: 1 },
    });
    const msg = await buildContextMessage(
      makeCtx({
        metadata: {
          reservation_draft: { date: '10/08/2026', partySize: 2 },
        },
      })
    );
    expect(msg).toContain('COMPLETAR_PEDIDO');
    expect(msg).not.toContain('COMPLETAR_RESERVA');
    const goalLines = msg
      .split('\n')
      .filter((l) => l.includes('Objetivo abierto'));
    expect(goalLines).toHaveLength(1);
  });

  it('pendingProductSelection: inyecta candidatos y consulta original', async () => {
    findFirstMock.mockResolvedValue(null);
    const idA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const idB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    menuFindManyMock.mockResolvedValue([
      { id: idA, name: 'Lomo a la plancha' },
      { id: idB, name: 'Lomo al tajo' },
    ]);
    const msg = await buildContextMessage(
      makeCtx({
        userMsg: 'el de la plancha',
        metadata: {
          pendingProductSelection: true,
          pendingQuestion: 'tienen lomo?',
          candidateProductIds: [idA, idB],
        },
      })
    );
    expect(msg).toContain('Selección de producto pendiente');
    expect(msg).toContain('Lomo a la plancha');
    expect(msg).toContain(idA);
    expect(msg).toContain('Consulta original del cliente');
    expect(msg).toContain('tienen lomo?');
    expect(msg.endsWith('el de la plancha')).toBe(true);
  });

  it('pendingTipables: inyecta tipables de gestión ofrecidos', async () => {
    findFirstMock.mockResolvedValue(null);
    const msg = await buildContextMessage(
      makeCtx({
        userMsg: 'nota',
        metadata: {
          pendingTipables: {
            offeredAt: new Date().toISOString(),
            management: ['VIEW_CART', 'ITEM_NOTE'],
          },
        },
      })
    );
    expect(msg).toContain('Tipables de gestión ofrecidos');
    expect(msg).toContain('ITEM_NOTE');
    expect(msg).toContain('present_cart');
  });

  it('pendingItemNote: prioriza nota y bloquea complementos en contexto', async () => {
    findFirstMock.mockResolvedValue(null);
    const msg = await buildContextMessage(
      makeCtx({
        userMsg: 'sin mucha azúcar',
        metadata: {
          pendingItemNote: {
            askedAt: new Date().toISOString(),
            productId: '11111111-1111-1111-1111-111111111111',
            productName: 'Chicha',
            source: 'tipable',
          },
        },
      })
    );
    expect(msg).toContain('Nota de ítem pendiente');
    expect(msg).toContain('update_item_note');
    expect(msg).toContain('PROHIBIDO add_cart_item');
    expect(msg.indexOf('Nota de ítem pendiente')).toBeLessThan(
      msg.indexOf('Personas para el pedido') >= 0
        ? msg.length
        : msg.indexOf('sin mucha azúcar')
    );
  });

  it('sin pendingProductSelection: no menciona selección pendiente', async () => {
    findFirstMock.mockResolvedValue(null);
    const msg = await buildContextMessage(makeCtx());
    expect(msg).not.toContain('Selección de producto pendiente');
    expect(menuFindManyMock).not.toHaveBeenCalled();
  });

  it('partySizeJustConfirmed: inyecta hint de resume sin metadata persistida', async () => {
    findFirstMock.mockResolvedValue(null);
    const msg = await buildContextMessage(
      makeCtx({
        userMsg: 'quiero papas',
        metadata: { peopleCount: 3, requestedPartySize: 3 },
        partySizeJustConfirmed: 3,
      })
    );
    expect(msg).toContain('Party size recién confirmado (3)');
    expect(msg).toContain('add_cart_item');
    expect(msg).toContain('PROHIBIDO present_product_cta(ADD_ITEM)');
    expect(msg).toContain('PROHIBIDO decir que ya sumaste');
    expect(msg).not.toContain('partySizeJustConfirmed');
  });

  it('sin partySizeJustConfirmed: no inyecta hint de resume', async () => {
    findFirstMock.mockResolvedValue(null);
    const msg = await buildContextMessage(
      makeCtx({
        userMsg: 'quiero papas',
        metadata: { peopleCount: 3, requestedPartySize: 3 },
      })
    );
    expect(msg).not.toContain('Party size recién confirmado');
  });
});
