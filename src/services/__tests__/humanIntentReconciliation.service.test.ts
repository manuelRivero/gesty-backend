import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  conversationStateFindUnique,
  draftOrderFindFirst,
  reconcileActiveMock,
  getActiveHumanIntentMock,
  cancelHumanIntentMock,
  FakeHumanIntentStateError,
} = vi.hoisted(() => ({
  conversationStateFindUnique: vi.fn(),
  draftOrderFindFirst: vi.fn(),
  reconcileActiveMock: vi.fn(),
  getActiveHumanIntentMock: vi.fn(),
  cancelHumanIntentMock: vi.fn(),
  FakeHumanIntentStateError: class FakeHumanIntentStateError extends Error {},
}));

vi.mock('../../lib/prisma', () => ({
  prisma: {
    conversation_state: { findUnique: conversationStateFindUnique },
    draft_order: { findFirst: draftOrderFindFirst },
  },
}));

vi.mock('../humanIntentState.service', () => ({
  HumanIntentStateError: FakeHumanIntentStateError,
  reconcileActiveHumanIntent: reconcileActiveMock,
  getActiveHumanIntent: getActiveHumanIntentMock,
  cancelHumanIntent: cancelHumanIntentMock,
}));

import {
  closeAbandonedPedirIntent,
  isPedirOrderFullyAbandoned,
  reconcileHumanIntentAfterToolEffect,
} from '../humanIntentReconciliation.service';

const ACTIVE = {
  id: 'intent-order',
  sequence: 1,
  goal: 'PEDIR',
  request: { products: ['A', 'B'] },
  status: 'ACTIVE',
  blockers: [],
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
};

const effect = {
  kind: 'add_cart_item',
  reference: 'product-b',
  occurredAt: '2026-09-28T00:00:00.000Z',
  success: true as const,
};

describe('reconcileHumanIntentAfterToolEffect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conversationStateFindUnique.mockResolvedValue({ metadata: {} });
    draftOrderFindFirst.mockResolvedValue({
      draft_order_item: [
        { product_id: 'product-a' },
        { product_id: 'product-b' },
      ],
    });
    reconcileActiveMock.mockImplementation(
      async (_conversationId, _effect, isSatisfied) =>
        isSatisfied(ACTIVE) ? { ...ACTIVE, status: 'RESOLVED' } : null
    );
  });

  it('no resuelve tras agregar A cuando B sigue en el plan, aunque el carrito tenga A', async () => {
    conversationStateFindUnique.mockResolvedValue({
      metadata: {
        pendingOrderLines: {
          lines: [{ id: 'line-b', hint: 'B', requestedQuantity: 1, status: 'queued' }],
        },
      },
    });
    draftOrderFindFirst.mockResolvedValue({
      draft_order_item: [{ product_id: 'product-a' }],
    });

    const resolved = await reconcileHumanIntentAfterToolEffect({
      conversationId: 'conv-1',
      businessId: 'biz-1',
      customerPhone: '+5491100000000',
      effect: { ...effect, reference: 'product-a' },
    });

    expect(resolved).toBeNull();
    expect(reconcileActiveMock.mock.calls[0][2](ACTIVE)).toBe(false);
  });

  it('resuelve cuando el efecto está en el carrito persistido y no queda plan abierto', async () => {
    const resolved = await reconcileHumanIntentAfterToolEffect({
      conversationId: 'conv-1',
      businessId: 'biz-1',
      customerPhone: '+5491100000000',
      effect,
    });

    expect(resolved).toMatchObject({ status: 'RESOLVED' });
    expect(reconcileActiveMock.mock.calls[0][2](ACTIVE)).toBe(true);
  });

  it('sin referencia de carrito, un efecto persistido no completa PEDIR', async () => {
    const resolved = await reconcileHumanIntentAfterToolEffect({
      conversationId: 'conv-1',
      businessId: 'biz-1',
      customerPhone: '+5491100000000',
      effect: { ...effect, reference: undefined },
    });

    expect(resolved).toBeNull();
    expect(reconcileActiveMock).toHaveBeenCalledOnce();
    expect(reconcileActiveMock.mock.calls[0][2](ACTIVE)).toBe(false);
  });
});

const abandonedParams = {
  conversationId: 'conv-1',
  businessId: 'biz-1',
  customerPhone: '+5491100000000',
};

const cancelledQueue = (createdAt: string) => ({
  pendingOrderLines: {
    lines: [{ id: 'line-lomo', hint: 'lomo saltado', requestedQuantity: 2, status: 'cancelled' }],
    sourceMessage: 'quiero un lomo saltado',
    createdAt,
  },
});

describe('closeAbandonedPedirIntent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    draftOrderFindFirst.mockResolvedValue({ draft_order_item: [] });
  });

  // Test C: la línea de "lomo saltado" se cancela, pero el REPLACE de este
  // mismo turno ya promovió "pollo a la brasa" a ACTIVE. El nuevo ACTIVE fue
  // creado DESPUÉS de que la cola abandonada se abriera, así que no puede ser
  // el dueño de esa cola — no debe cerrarse.
  it('no cancela el intent sustituto (pollo) promovido por REPLACE en este turno', async () => {
    conversationStateFindUnique.mockResolvedValue({
      metadata: cancelledQueue('2026-10-22T13:15:00.000Z'),
    });
    const substitute = {
      id: 'intent-pollo',
      sequence: 2,
      goal: 'PEDIR',
      request: { products: ['pollo a la brasa'] },
      status: 'ACTIVE',
      blockers: [],
      createdAt: '2026-10-22T13:16:30.000Z', // posterior a la cola: fruto del REPLACE de este turno
      updatedAt: '2026-10-22T13:16:30.000Z',
    };
    getActiveHumanIntentMock.mockResolvedValue(substitute);

    const result = await closeAbandonedPedirIntent(abandonedParams);

    expect(result).toBeNull();
    expect(cancelHumanIntentMock).not.toHaveBeenCalled();
  });

  // Test D: no hubo REPLACE — el ACTIVE es el mismo intent que abrió la cola
  // (su createdAt es anterior a la de la cola), y la cola quedó totalmente
  // cancelada. Debe cerrarse como abandonado, como hoy.
  it('cancela el intent correspondiente cuando no hubo reemplazo', async () => {
    conversationStateFindUnique.mockResolvedValue({
      metadata: cancelledQueue('2026-10-22T13:15:00.000Z'),
    });
    const owner = {
      id: 'intent-lomo',
      sequence: 1,
      goal: 'PEDIR',
      request: { products: ['lomo saltado'] },
      status: 'ACTIVE',
      blockers: [],
      createdAt: '2026-10-22T13:10:00.000Z', // anterior a la cola: el mismo intent que la abrió
      updatedAt: '2026-10-22T13:10:00.000Z',
    };
    getActiveHumanIntentMock.mockResolvedValue(owner);
    cancelHumanIntentMock.mockResolvedValue({ ...owner, status: 'CANCELLED' });

    const result = await closeAbandonedPedirIntent(abandonedParams);

    expect(cancelHumanIntentMock).toHaveBeenCalledWith(abandonedParams.conversationId, owner.id);
    expect(result).toMatchObject({ status: 'CANCELLED' });
  });

  // Test E: no hay evidencia suficiente para demostrar que el ACTIVE actual
  // es el dueño de la cola (timestamps empatados, o no parseables). No se
  // cancela por defecto: fail-closed, sin fallback silencioso.
  it('no cancela cuando no se puede demostrar que el ACTIVE es el dueño de la cola (timestamps empatados)', async () => {
    const tie = '2026-10-22T13:15:00.000Z';
    conversationStateFindUnique.mockResolvedValue({ metadata: cancelledQueue(tie) });
    const ambiguous = {
      id: 'intent-ambiguous',
      sequence: 1,
      goal: 'PEDIR',
      request: { products: ['lomo saltado'] },
      status: 'ACTIVE',
      blockers: [],
      createdAt: tie,
      updatedAt: tie,
    };
    getActiveHumanIntentMock.mockResolvedValue(ambiguous);

    const result = await closeAbandonedPedirIntent(abandonedParams);

    expect(result).toBeNull();
    expect(cancelHumanIntentMock).not.toHaveBeenCalled();
  });

  it('no cancela cuando el createdAt de la cola no es parseable', () => {
    const owner = {
      id: 'intent-lomo',
      sequence: 1,
      goal: 'PEDIR' as const,
      request: { products: ['lomo saltado'] },
      status: 'ACTIVE' as const,
      blockers: [],
      createdAt: '2026-10-22T13:10:00.000Z',
      updatedAt: '2026-10-22T13:10:00.000Z',
    };
    const metadata = {
      pendingOrderLines: {
        lines: [{ id: 'line-lomo', hint: 'lomo saltado', requestedQuantity: 2, status: 'cancelled' }],
        sourceMessage: 'quiero un lomo saltado',
        createdAt: 'not-a-date',
      },
    };

    expect(isPedirOrderFullyAbandoned(owner, metadata, false)).toBe(false);
  });
});