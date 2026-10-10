import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateNextOrderLine,
  advanceAfterLineClose,
  associateProductResolutionToTask,
  buildOrderLinesContinueOrCancelHint,
  buildPendingOrderLinesContextLines,
  cancelOrderLine,
  clearPendingOrderLines,
  ensurePendingOrderLinesFromRequest,
  getActiveOrderLine,
  getNextOrderLineRequiringQuantity,
  getPendingOrderLines,
  hasOpenOrderLines,
  normalizeOrderLineInput,
  ORDER_LINES_MAX,
  OrderLineCloseError,
  parsePendingOrderLines,
  resolveMissedSearchOrderLine,
  resolveOrderLineForProduct,
  ingredientFilterCarvesDishHint,
  buildOrderLineSearchInstruction,
  setPendingOrderLines,
  setOrderLineRequestedQuantity,
  validateCurrentProductResolutionForTask,
  type PendingOrderLines,
} from '../pendingOrderLines.service';

const patchConversationMetadata = vi.fn();
const omitConversationMetadataKeys = vi.fn();
const conversationMetadata = { value: {} as Record<string, unknown> };

vi.mock('../../repositories', () => ({
  patchConversationMetadata: (...args: unknown[]) => patchConversationMetadata(...args),
  omitConversationMetadataKeys: (...args: unknown[]) => omitConversationMetadataKeys(...args),
  mutateConversationMetadata: async (
    _conversationId: string,
    mutate: (current: Record<string, unknown>) => {
      metadata: Record<string, unknown> | null;
      result: unknown;
    }
  ) => {
    const mutation = mutate(conversationMetadata.value);
    if (mutation.metadata) conversationMetadata.value = mutation.metadata;
    return mutation.result;
  },
}));

const basePending = (over: Partial<PendingOrderLines> = {}): PendingOrderLines => ({
  lines: [
    { id: 'l1', hint: 'lomo saltado', requestedQuantity: 3, status: 'active', currentResolutionId: 'pr1:biz-1:conv-1:res-1', pendingNote: null },
    { id: 'l2', hint: 'ceviche', requestedQuantity: 2, status: 'queued', currentResolutionId: 'pr1:biz-1:conv-1:res-2', pendingNote: null },
    { id: 'l3', hint: 'bebida', requestedQuantity: null, status: 'queued', currentResolutionId: 'pr1:biz-1:conv-1:res-3', pendingNote: null },
  ],
  sourceMessage: '3 lomos, 2 ceviches y una bebida',
  createdAt: new Date().toISOString(),
  ...over,
});

describe('pendingOrderLines.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parsePendingOrderLines valida shape y descarta líneas inválidas', () => {
    expect(parsePendingOrderLines(null)).toBeNull();
    expect(parsePendingOrderLines({ lines: [] })).toBeNull();
    const parsed = parsePendingOrderLines(basePending());
    expect(parsed?.lines).toHaveLength(3);
  });

  it('getActiveOrderLine: primera active, si no hay primera queued (D1)', () => {
    expect(getActiveOrderLine(basePending())).toMatchObject({ id: 'l1', status: 'active' });
    const noActive = basePending({
      lines: [
        { id: 'l1', hint: 'lomo', requestedQuantity: null, status: 'done', currentResolutionId: 'pr1:biz-1:conv-1:res-1', pendingNote: null },
        { id: 'l2', hint: 'ceviche', requestedQuantity: null, status: 'queued', currentResolutionId: 'pr1:biz-1:conv-1:res-2', pendingNote: null },
      ],
    });
    expect(getActiveOrderLine(noActive)).toMatchObject({ id: 'l2', status: 'queued' });
    expect(getActiveOrderLine(null)).toBeNull();
  });

  it('requiere currentResolutionId válida para abrir Quantity Goal', () => {
    const pending = basePending({
      lines: [
        { id: 'papas', hint: 'papas', requestedQuantity: null, status: 'active', currentResolutionId: null, pendingNote: null },
        { id: 'ceviche', hint: 'ceviche', requestedQuantity: null, status: 'queued', currentResolutionId: 'pr1:b:conv:valid', pendingNote: null },
      ],
    });
    expect(getNextOrderLineRequiringQuantity(pending)?.id).toBe('ceviche');
    expect(getNextOrderLineRequiringQuantity({
      ...pending,
      lines: pending.lines.map((line) => ({ ...line, currentResolutionId: null })),
    })).toBeNull();
  });

  it('permite asociar y validar currentResolutionId explícita para una task', async () => {
    const pending = basePending({
      lines: [{ id: 'task-1', hint: 'ceviche', requestedQuantity: null, status: 'active', currentResolutionId: null, pendingNote: null }],
    });
    const resolution = {
      resolutionId: 'pr1:biz-1:conv-1:resolution-1',
      productId: 'prod-1',
      businessId: 'biz-1',
      conversationId: 'conv-1',
      source: 'search_products' as const,
      status: 'selected' as const,
      scope: 'conversation' as const,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    conversationMetadata.value = {
      pendingOrderLines: pending,
      productResolutions: [resolution],
    };
    const associated = await associateProductResolutionToTask({
      conversationId: 'conv-1',
      businessId: 'biz-1',
      taskId: 'task-1',
      resolutionId: resolution.resolutionId,
    });
    expect(associated.ok).toBe(true);
    if (!associated.ok) return;
    expect(associated.pending.lines[0].currentResolutionId).toBe(resolution.resolutionId);
    expect(validateCurrentProductResolutionForTask({
      task: associated.pending.lines[0],
      businessId: 'biz-1',
      conversationId: 'conv-1',
      resolution,
    }).ok).toBe(true);
  });

  it('rechaza asociar a una task ACTIVE una resolución que ya pertenece a otra task', async () => {
    const resolution = {
      resolutionId: 'pr1:biz-1:conv-1:shared',
      productId: 'prod-1',
      businessId: 'biz-1',
      conversationId: 'conv-1',
      status: 'selected',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    conversationMetadata.value = {
      pendingOrderLines: basePending({
        lines: [
          { id: 'task-a', hint: 'ceviche', requestedQuantity: 2, status: 'done', currentResolutionId: resolution.resolutionId, pendingNote: null },
          { id: 'task-b', hint: 'ceviche', requestedQuantity: 1, status: 'active', currentResolutionId: null, pendingNote: null },
        ],
      }),
      productResolutions: [resolution],
    };

    const result = await associateProductResolutionToTask({
      conversationId: 'conv-1',
      businessId: 'biz-1',
      taskId: 'task-b',
      resolutionId: resolution.resolutionId,
    });

    expect(result).toEqual({ ok: false, reason: 'resolution_already_owned' });
    expect(getPendingOrderLines(conversationMetadata.value)?.lines).toMatchObject([
      { id: 'task-a', currentResolutionId: resolution.resolutionId },
      { id: 'task-b', currentResolutionId: null },
    ]);
  });

  it('associateProductResolutionToTask rechaza una Task QUEUED con task_not_active y sin mutación', async () => {
    const resolution = {
      resolutionId: 'pr1:biz-1:conv-1:queued',
      productId: 'prod-1',
      businessId: 'biz-1',
      conversationId: 'conv-1',
      status: 'selected',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    conversationMetadata.value = {
      pendingOrderLines: basePending({
        lines: [
          { id: 'task-a', hint: 'ceviche', requestedQuantity: 2, status: 'active', currentResolutionId: null, pendingNote: null },
          { id: 'task-b', hint: 'papas', requestedQuantity: null, status: 'queued', currentResolutionId: null, pendingNote: null },
        ],
      }),
      productResolutions: [resolution],
    };
    const before = structuredClone(conversationMetadata.value);

    const result = await associateProductResolutionToTask({
      conversationId: 'conv-1',
      businessId: 'biz-1',
      taskId: 'task-b',
      resolutionId: resolution.resolutionId,
    });

    expect(result).toEqual({ ok: false, reason: 'task_not_active' });
    expect(conversationMetadata.value).toEqual(before);
  });

  it('associateProductResolutionToTask: una Task cerrada sigue siendo task_not_open', async () => {
    conversationMetadata.value = {
      pendingOrderLines: basePending({
        lines: [{ id: 'task-a', hint: 'ceviche', requestedQuantity: 2, status: 'done', currentResolutionId: null, pendingNote: null }],
      }),
    };

    const result = await associateProductResolutionToTask({
      conversationId: 'conv-1',
      businessId: 'biz-1',
      taskId: 'task-a',
      resolutionId: 'pr1:biz-1:conv-1:any',
    });

    expect(result).toEqual({ ok: false, reason: 'task_not_open' });
  });

  it('permite renovar solo la resolución inválida de la misma Task', async () => {
    const expiredId = 'pr1:biz-1:conv-1:expired';
    const freshId = 'pr1:biz-1:conv-1:fresh';
    const pending = basePending({
      lines: [{ id: 'task-a', hint: 'ceviche', requestedQuantity: null, status: 'active', currentResolutionId: expiredId, pendingNote: null }],
    });
    conversationMetadata.value = {
      pendingOrderLines: pending,
      productResolutions: [
        {
          resolutionId: expiredId, productId: 'prod-1', businessId: 'biz-1',
          conversationId: 'conv-1', status: 'selected', expiresAt: '2000-01-01T00:00:00.000Z',
        },
        {
          resolutionId: freshId, productId: 'prod-1', businessId: 'biz-1',
          conversationId: 'conv-1', status: 'selected',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    };

    const result = await associateProductResolutionToTask({
      conversationId: 'conv-1',
      businessId: 'biz-1',
      taskId: 'task-a',
      resolutionId: freshId,
    });

    expect(result).toMatchObject({
      ok: true,
      pending: { lines: [{ id: 'task-a', currentResolutionId: freshId }] },
    });
  });

  it('selecciona la línea UNKNOWN activa y luego la primera queued UNKNOWN', () => {
    const pending = basePending({
      lines: [
        { id: 'papas', hint: 'papas', requestedQuantity: null, status: 'active', currentResolutionId: 'pr1:biz-1:conv-1:res-1', pendingNote: null },
        { id: 'ceviche', hint: 'ceviche', requestedQuantity: null, status: 'queued', currentResolutionId: 'pr1:biz-1:conv-1:res-2', pendingNote: null },
      ],
    });
    expect(getNextOrderLineRequiringQuantity(pending)?.id).toBe('papas');
    expect(getNextOrderLineRequiringQuantity({
      ...pending,
      lines: pending.lines.map((line) =>
        line.id === 'papas' ? { ...line, requestedQuantity: 2 } : line
      ),
    })?.id).toBe('ceviche');
  });

  it('persiste cantidad confirmada sin alterar status ni convertir otros UNKNOWN', async () => {
    const pending = basePending({
      lines: [
        { id: 'papas', hint: 'papas', requestedQuantity: null, status: 'active', currentResolutionId: 'pr1:biz-1:conv-1:res-1', pendingNote: null },
        { id: 'ceviche', hint: 'ceviche', requestedQuantity: null, status: 'queued', currentResolutionId: 'pr1:biz-1:conv-1:res-2', pendingNote: null },
      ],
    });
    const next = await setOrderLineRequestedQuantity({
      conversationId: 'conv-1',
      metadata: {
        pendingOrderLines: pending,
        productResolutions: [
          { resolutionId: 'pr1:biz-1:conv-1:res-1', productId: 'p-1', businessId: 'biz-1', conversationId: 'conv-1', status: 'selected', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() },
          { resolutionId: 'pr1:biz-1:conv-1:res-2', productId: 'p-2', businessId: 'biz-1', conversationId: 'conv-1', status: 'selected', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() },
        ],
      },
      orderLineId: 'papas',
      quantity: 2,
    });
    expect(next?.lines).toMatchObject([
      { id: 'papas', requestedQuantity: 2, status: 'active' },
      { id: 'ceviche', requestedQuantity: null, status: 'queued' },
    ]);
  });

  it('hasOpenOrderLines: true con queued/active, false con todo done/cancelled o sin cola', () => {
    expect(hasOpenOrderLines({ pendingOrderLines: basePending() })).toBe(true);
    expect(hasOpenOrderLines({})).toBe(false);
    expect(
      hasOpenOrderLines({
        pendingOrderLines: basePending({
          lines: [
            { id: 'l1', hint: 'lomo', requestedQuantity: null, status: 'done', currentResolutionId: 'pr1:biz-1:conv-1:res-1', pendingNote: null },
            { id: 'l2', hint: 'ceviche', requestedQuantity: null, status: 'cancelled', currentResolutionId: 'pr1:biz-1:conv-1:res-2', pendingNote: null },
          ],
        }),
      })
    ).toBe(false);
  });

  it('setPendingOrderLines marca la primera línea active y el resto queued', async () => {
    const pending = await setPendingOrderLines({
      conversationId: 'conv-1',
      lines: [{ hint: 'lomo', requestedQuantity: 3 }, { hint: 'ceviche' }],
      sourceMessage: '3 lomos y un ceviche',
    });
    expect(pending.lines[0]).toMatchObject({ hint: 'lomo', requestedQuantity: 3, status: 'active' });
    expect(pending.lines[1]).toMatchObject({ hint: 'ceviche', requestedQuantity: null, status: 'queued' });
    expect(patchConversationMetadata).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ pendingOrderLines: expect.any(Object) })
    );
  });

  it('materializa products de PEDIR conservando cantidades desconocidas', async () => {
    const pending = await ensurePendingOrderLinesFromRequest({
      conversationId: 'conv-1',
      request: { products: ['papas a la huancaína', 'ceviche'] },
      sourceMessage: 'Quiero papas a la huancaína y ceviche',
      metadata: {},
    });
    expect(pending?.lines).toMatchObject([
      { hint: 'papas a la huancaína', requestedQuantity: null, status: 'active', currentResolutionId: null, pendingNote: null },
      { hint: 'ceviche', requestedQuantity: null, status: 'queued', currentResolutionId: null, pendingNote: null },
    ]);
  });

  describe('ensurePendingOrderLinesFromRequest — shapes de request.products', () => {
    it('A — legacy: products como string[] sigue creando OrderLines (sin nota)', async () => {
      const pending = await ensurePendingOrderLinesFromRequest({
        conversationId: 'conv-1',
        request: { products: ['ceviche', 'papas a la huancaína'] },
        sourceMessage: 'Quiero ceviche y papas a la huancaína',
        metadata: {},
      });
      expect(pending?.lines).toMatchObject([
        { hint: 'ceviche', requestedQuantity: null, pendingNote: null },
        { hint: 'papas a la huancaína', requestedQuantity: null, pendingNote: null },
      ]);
    });

    it('B — quantity existente: products como [{name, quantity}] mantiene el comportamiento actual', async () => {
      const pending = await ensurePendingOrderLinesFromRequest({
        conversationId: 'conv-1',
        request: { products: [{ name: 'ceviche', quantity: 2 }] },
        sourceMessage: 'Quiero 2 ceviches',
        metadata: {},
      });
      expect(pending?.lines).toMatchObject([
        { hint: 'ceviche', requestedQuantity: 2, pendingNote: null },
      ]);
    });

    it('C — nota: products como [{name, note}] produce pendingNote correctamente', async () => {
      const pending = await ensurePendingOrderLinesFromRequest({
        conversationId: 'conv-1',
        request: {
          products: [
            { name: 'ceviche', note: 'poca cebolla' },
            { name: 'papas a la huancaína', note: 'no muy picantes' },
          ],
        },
        sourceMessage: 'Quiero un ceviche con poca cebolla y unas papas a la huancaína no muy picantes',
        metadata: {},
      });
      expect(pending?.lines).toMatchObject([
        { hint: 'ceviche', requestedQuantity: null, pendingNote: 'poca cebolla' },
        { hint: 'papas a la huancaína', requestedQuantity: null, pendingNote: 'no muy picantes' },
      ]);
    });

    it('D — quantity + note sobreviven simultáneamente en la misma línea', async () => {
      const pending = await ensurePendingOrderLinesFromRequest({
        conversationId: 'conv-1',
        request: { products: [{ name: 'ceviche', quantity: 2, note: 'poca cebolla' }] },
        sourceMessage: 'Quiero 2 ceviches con poca cebolla',
        metadata: {},
      });
      expect(pending?.lines).toMatchObject([
        { hint: 'ceviche', requestedQuantity: 2, pendingNote: 'poca cebolla' },
      ]);
    });

    it('H — producto sin note conserva pendingNote: null (no inventa notas)', async () => {
      const pending = await ensurePendingOrderLinesFromRequest({
        conversationId: 'conv-1',
        request: {
          products: [
            { name: 'ceviche', note: 'poca cebolla' },
            { name: 'papas a la huancaína' },
          ],
        },
        sourceMessage: 'Quiero un ceviche con poca cebolla y unas papas a la huancaína',
        metadata: {},
      });
      expect(pending?.lines).toMatchObject([
        { hint: 'ceviche', pendingNote: 'poca cebolla' },
        { hint: 'papas a la huancaína', pendingNote: null },
      ]);
    });
  });

  describe('normalizeOrderLineInput (cantidad dentro del hint)', () => {
    it('extrae el número que el modelo dejó en el hint', () => {
      expect(normalizeOrderLineInput({ hint: '2 papas a la huancaína' })).toEqual({
        hint: 'papas a la huancaína',
        requestedQuantity: 2,
      });
      expect(normalizeOrderLineInput({ hint: '1 ceviche' })).toEqual({
        hint: 'ceviche',
        requestedQuantity: 1,
      });
      expect(normalizeOrderLineInput({ hint: '3x lomo saltado' })).toEqual({
        hint: 'lomo saltado',
        requestedQuantity: 3,
      });
    });

    it('limpia el número del hint y respeta la cantidad explícita del modelo', () => {
      expect(
        normalizeOrderLineInput({ hint: '2 papas', requestedQuantity: 4 })
      ).toEqual({ hint: 'papas', requestedQuantity: 4 });
    });

    it('sin número no invita cantidad: artículo no es cantidad (D4)', () => {
      expect(normalizeOrderLineInput({ hint: 'una bebida' })).toEqual({
        hint: 'una bebida',
        requestedQuantity: null,
      });
      expect(normalizeOrderLineInput({ hint: 'ceviche' })).toEqual({
        hint: 'ceviche',
        requestedQuantity: null,
      });
    });

    it('no deja el hint vacío ni acepta restos muy cortos', () => {
      expect(normalizeOrderLineInput({ hint: '2' })).toEqual({
        hint: '2',
        requestedQuantity: null,
      });
      expect(normalizeOrderLineInput({ hint: '2 ok' })).toEqual({
        hint: '2 ok',
        requestedQuantity: null,
      });
    });
  });

  it('setPendingOrderLines normaliza cantidades embebidas en el hint', async () => {
    const pending = await setPendingOrderLines({
      conversationId: 'conv-1',
      lines: [{ hint: '1 ceviche' }, { hint: '2 papas a la huancaína' }],
      sourceMessage: '1 ceviche, 2 papas a la huancaína',
    });
    expect(pending.lines[0]).toMatchObject({ hint: 'ceviche', requestedQuantity: 1 });
    expect(pending.lines[1]).toMatchObject({
      hint: 'papas a la huancaína',
      requestedQuantity: 2,
    });
  });

  describe('ingredientFilterCarvesDishHint', () => {
    it('bloquea containsIngredient recortado de un hint de plato (log papas → ensalada)', () => {
      expect(ingredientFilterCarvesDishHint('papas a la huancaína', 'papa')).toBe(true);
      expect(ingredientFilterCarvesDishHint('ceviche mixto', 'ceviche')).toBe(true);
    });

    it('no dispara en hints de sección/rol: el filtro no recorta un plato', () => {
      expect(ingredientFilterCarvesDishHint('algo de beber', 'beber')).toBe(false);
      expect(ingredientFilterCarvesDishHint('una bebida', 'bebida')).toBe(false);
      expect(ingredientFilterCarvesDishHint('papas', 'papa')).toBe(false);
    });

    it('no dispara si el filtro no es token del hint (alergia, otro ingrediente)', () => {
      expect(ingredientFilterCarvesDishHint('papas a la huancaína', 'maní')).toBe(false);
      expect(ingredientFilterCarvesDishHint('papas a la huancaína', null)).toBe(false);
      expect(ingredientFilterCarvesDishHint('papas a la huancaína', '  ')).toBe(false);
    });

    it('resolveMissedSearchOrderLine cierra el hint cubierto y no un recorte ni otro plato', () => {
      const pending = basePending();
      expect(resolveMissedSearchOrderLine(pending, 'lomo saltado')?.id).toBe('l1');
      expect(resolveMissedSearchOrderLine(pending, 'lomo')).toBeNull();
      expect(resolveMissedSearchOrderLine(pending, 'ceviche')?.id).toBe('l2');
      expect(resolveMissedSearchOrderLine(pending, 'papa')).toBeNull();
      expect(resolveMissedSearchOrderLine(null, 'lomo')).toBeNull();
    });

    it('resolveMissedSearchOrderLine con empate prefiere la línea activa', () => {
      const pending = basePending({
        lines: [
          { id: 'q', hint: 'lomo', requestedQuantity: null, status: 'queued', currentResolutionId: null, pendingNote: null },
          { id: 'a', hint: 'lomo', requestedQuantity: null, status: 'active', currentResolutionId: null, pendingNote: null },
        ],
      });
      expect(resolveMissedSearchOrderLine(pending, 'lomo')?.id).toBe('a');
    });

    it('buildOrderLineSearchInstruction nombra vectorial para plato y categoría para sección', () => {
      const text = buildOrderLineSearchInstruction('papas a la huancaína');
      expect(text).toContain('search_products(keyword="papas a la huancaína")');
      expect(text).toMatch(/containsIngredient/);
      expect(text).toMatch(/algo de beber/);
      expect(text).toMatch(/present_category/);
    });
  });

  it('setPendingOrderLines topea en ORDER_LINES_MAX líneas', async () => {
    const many = Array.from({ length: ORDER_LINES_MAX + 5 }, (_, i) => ({ hint: `plato ${i}` }));
    const pending = await setPendingOrderLines({
      conversationId: 'conv-1',
      lines: many,
      sourceMessage: 'muchos platos',
    });
    expect(pending.lines).toHaveLength(ORDER_LINES_MAX);
  });

  it('advanceAfterLineClose cierra exclusivamente la Task indicada y deja la próxima en queued', async () => {
    const pending = basePending();
    conversationMetadata.value = { pendingOrderLines: pending };
    const next = await advanceAfterLineClose({
      conversationId: 'conv-1',
      lineId: 'l1',
      closeStatus: 'done',
    });
    expect(next?.lines.find((l) => l.id === 'l1')?.status).toBe('done');
    expect(next?.lines.find((l) => l.id === 'l2')?.status).toBe('queued');
    // D1: the close does not activate the next queued Task.
    expect(getActiveOrderLine(next)).toMatchObject({ id: 'l2', status: 'queued' });
  });

  it('advanceAfterLineClose limpia la cola entera cuando no queda nada abierto', async () => {
    const oneLine = basePending({
      lines: [{ id: 'l1', hint: 'lomo', requestedQuantity: null, status: 'active', currentResolutionId: 'pr1:biz-1:conv-1:res-1', pendingNote: null }],
    });
    conversationMetadata.value = { pendingOrderLines: oneLine };
    const next = await advanceAfterLineClose({
      conversationId: 'conv-1',
      lineId: 'l1',
      closeStatus: 'done',
    });
    expect(next).toBeNull();
    expect(conversationMetadata.value.pendingOrderLines).toBeUndefined();
  });

  it('rechaza un orderLineId stale sin cerrar el Task active', async () => {
    const pending = basePending({
      lines: [
        { id: 'task-b', hint: 'ceviche', requestedQuantity: 2, status: 'active', currentResolutionId: 'r-b', pendingNote: null },
      ],
    });
    conversationMetadata.value = { pendingOrderLines: pending };

    await expect(advanceAfterLineClose({
      conversationId: 'conv-1',
      lineId: 'task-a-stale',
      closeStatus: 'done',
    })).rejects.toMatchObject({ reason: 'order_line_not_found' } satisfies Partial<OrderLineCloseError>);
    expect(getPendingOrderLines(conversationMetadata.value)?.lines).toEqual(pending.lines);
  });

  it('rechaza un orderLineId stale sin cerrar active ni queued Tasks', async () => {
    const pending = basePending({
      lines: [
        { id: 'task-b', hint: 'ceviche', requestedQuantity: 2, status: 'active', currentResolutionId: 'r-b', pendingNote: null },
        { id: 'task-c', hint: 'milanesa', requestedQuantity: 1, status: 'queued', currentResolutionId: 'r-c', pendingNote: null },
      ],
    });
    conversationMetadata.value = { pendingOrderLines: pending };

    await expect(advanceAfterLineClose({
      conversationId: 'conv-1',
      lineId: 'task-a-stale',
      closeStatus: 'done',
    })).rejects.toMatchObject({ reason: 'order_line_not_found' });
    expect(getPendingOrderLines(conversationMetadata.value)?.lines).toEqual(pending.lines);
  });

  it('no sustituye un ID inexistente por la primera Task del array', async () => {
    const pending = basePending({
      lines: [
        { id: 'task-y', hint: 'milanesa', requestedQuantity: 1, status: 'active', currentResolutionId: 'r-y', pendingNote: null },
        { id: 'task-z', hint: 'ceviche', requestedQuantity: 1, status: 'queued', currentResolutionId: 'r-z', pendingNote: null },
      ],
    });
    conversationMetadata.value = { pendingOrderLines: pending };

    await expect(advanceAfterLineClose({
      conversationId: 'conv-1',
      lineId: 'task-x',
      closeStatus: 'cancelled',
    })).rejects.toMatchObject({ reason: 'order_line_not_found' });
    expect(getPendingOrderLines(conversationMetadata.value)?.lines).toEqual(pending.lines);
  });

  it('permite el active fallback solo con opt-in genérico explícito', async () => {
    const pending = basePending();
    conversationMetadata.value = { pendingOrderLines: pending };
    const next = await advanceAfterLineClose({
      conversationId: 'conv-1',
      allowActiveFallback: true,
      closeStatus: 'cancelled',
    });
    expect(next?.lines.find((line) => line.id === 'l1')?.status).toBe('cancelled');
    expect(next?.lines.find((line) => line.id === 'l2')?.status).toBe('queued');
  });

  it('falla cerrado sin Task ID cuando existe una cola abierta', async () => {
    const pending = basePending();
    conversationMetadata.value = { pendingOrderLines: pending };

    await expect(advanceAfterLineClose({
      conversationId: 'conv-1',
      closeStatus: 'done',
    })).rejects.toMatchObject({ reason: 'order_line_id_required' });
    expect(getPendingOrderLines(conversationMetadata.value)?.lines).toEqual(pending.lines);
  });

  it('activateNextOrderLine activa la próxima queued solo si no hay ya una active', async () => {
    const noActive = basePending({
      lines: [
        { id: 'l1', hint: 'lomo', requestedQuantity: null, status: 'done', currentResolutionId: 'pr1:biz-1:conv-1:res-1', pendingNote: null },
        { id: 'l2', hint: 'ceviche', requestedQuantity: null, status: 'queued', currentResolutionId: 'pr1:biz-1:conv-1:res-2', pendingNote: null },
      ],
    });
    const next = await activateNextOrderLine('conv-1', { pendingOrderLines: noActive });
    expect(next.outcome).toBe('activated');
    expect(next.pending?.lines.find((l) => l.id === 'l2')?.status).toBe('active');
    expect(next.outcome === 'activated' && next.activatedLine.id).toBe('l2');

    patchConversationMetadata.mockClear();
    const alreadyActive = basePending();
    const unchanged = await activateNextOrderLine('conv-1', { pendingOrderLines: alreadyActive });
    expect(unchanged).toEqual({ outcome: 'already_active', pending: alreadyActive, activeLine: alreadyActive.lines[0] });
    expect(patchConversationMetadata).not.toHaveBeenCalled();

    expect(await activateNextOrderLine('conv-1', {})).toEqual({ outcome: 'no_queued_lines', pending: null });
    expect(patchConversationMetadata).not.toHaveBeenCalled();
  });

  it('cancelOrderLine cancela por hint o por línea activa', async () => {
    const pending = basePending();
    conversationMetadata.value = { pendingOrderLines: pending };
    const next = await cancelOrderLine({
      conversationId: 'conv-1',
      metadata: { pendingOrderLines: pending },
      hint: 'ceviche',
    });
    expect(next?.lines.find((l) => l.id === 'l2')?.status).toBe('cancelled');
    expect(next?.lines.find((l) => l.id === 'l1')?.status).toBe('active');
  });

  it('cancelOrderLine no cae al hint ni al Task active si el ID explícito es stale', async () => {
    const pending = basePending({
      lines: [
        { id: 'task-b', hint: 'ceviche', requestedQuantity: 1, status: 'active', currentResolutionId: 'r-b', pendingNote: null },
      ],
    });
    conversationMetadata.value = { pendingOrderLines: pending };

    await expect(cancelOrderLine({
      conversationId: 'conv-1',
      metadata: { pendingOrderLines: pending },
      lineId: 'task-a-stale',
      hint: 'ceviche',
    })).rejects.toMatchObject({ reason: 'order_line_not_found' });
    expect(getPendingOrderLines(conversationMetadata.value)?.lines).toEqual(pending.lines);
  });

  it('cancelOrderLine con hint sin match no cancela el Task active', async () => {
    const pending = basePending({
      lines: [
        { id: 'task-b', hint: 'ceviche', requestedQuantity: 1, status: 'active', currentResolutionId: 'r-b', pendingNote: null },
      ],
    });
    conversationMetadata.value = { pendingOrderLines: pending };

    await expect(cancelOrderLine({
      conversationId: 'conv-1',
      metadata: { pendingOrderLines: pending },
      hint: 'lomo',
    })).rejects.toMatchObject({ reason: 'order_line_not_found' });
    expect(getPendingOrderLines(conversationMetadata.value)?.lines).toEqual(pending.lines);
  });

  it('cancelOrderLine con hint ambiguo no elige la primera coincidencia', async () => {
    const pending = basePending({
      lines: [
        { id: 'task-a', hint: 'ceviche clásico', requestedQuantity: 1, status: 'active', currentResolutionId: 'r-a', pendingNote: null },
        { id: 'task-b', hint: 'ceviche mixto', requestedQuantity: 1, status: 'queued', currentResolutionId: 'r-b', pendingNote: null },
      ],
    });
    conversationMetadata.value = { pendingOrderLines: pending };

    await expect(cancelOrderLine({
      conversationId: 'conv-1',
      metadata: { pendingOrderLines: pending },
      hint: 'ceviche',
    })).rejects.toMatchObject({ reason: 'order_line_ambiguous' });
    expect(getPendingOrderLines(conversationMetadata.value)?.lines).toEqual(pending.lines);
  });

  it('clearPendingOrderLines omite la clave completa', async () => {
    await clearPendingOrderLines('conv-1');
    expect(omitConversationMetadataKeys).toHaveBeenCalledWith('conv-1', ['pendingOrderLines']);
  });

  it('buildOrderLinesContinueOrCancelHint arma el hint con la próxima queued y el conteo restante', () => {
    const hint = buildOrderLinesContinueOrCancelHint(basePending());
    expect(hint).toMatchObject({ nextHint: 'ceviche', remaining: 3 });
    expect(hint?.instruction).toMatch(/ceviche/);
    expect(hint?.instruction).toMatch(/NO arranques/);
    // Vocabulario de UX acordado: "producto(s)", no "línea(s)"; y se informa que al
    // terminar se podrá ajustar cantidades/notas (ver reactAgent.ts para el copy literal).
    expect(hint?.instruction).toMatch(/producto\(s\)/);
    expect(hint?.instruction).not.toMatch(/línea/);
    expect(hint?.instruction).toMatch(/atender otra necesidad dejando el pedido actual como está/);
    expect(hint?.instruction).toMatch(/agregar notas y ajustar cantidades/);
  });

  it('buildOrderLinesContinueOrCancelHint es null sin líneas queued', () => {
    const allClosed = basePending({
      lines: [{ id: 'l1', hint: 'lomo', requestedQuantity: null, status: 'active', currentResolutionId: null, pendingNote: null }],
    });
    expect(buildOrderLinesContinueOrCancelHint(allClosed)).toBeNull();
  });

  it('buildPendingOrderLinesContextLines proyecta la línea activa y las que faltan, sin confirmar cantidad del mensaje original', () => {
    const lines = buildPendingOrderLinesContextLines({ pendingOrderLines: basePending() });
    const text = lines.join('\n');
    expect(text).toMatch(/lomo saltado/);
    expect(text).toMatch(/ceviche/);
    expect(text).toMatch(/bebida/);
    expect(text).toMatch(/SOLO la línea activa/);
    expect(text).toMatch(/search_products\(keyword=/);
    expect(text).toMatch(/algo de beber/);
    expect(text).toMatch(/PROHIBIDO ofrecer complementos/);
  });

  it('después de cerrar A, B queda pendiente y el contexto indica continue_order_line', () => {
    const lines = buildPendingOrderLinesContextLines({
      pendingOrderLines: basePending({
        lines: [
          { id: 'l1', hint: 'A', requestedQuantity: 1, status: 'done', currentResolutionId: null, pendingNote: null },
          { id: 'l2', hint: 'B', requestedQuantity: 2, status: 'queued', currentResolutionId: null, pendingNote: null },
        ],
      }),
    });

    const text = lines.join('\n');
    expect(text).toContain('no hay una línea activa actualmente');
    expect(text).toContain('*B* (2×) [orderLineId: l2]');
    expect(text).toContain('continue_order_line()');
    expect(text).not.toContain('línea activa ahora');
    expect(text).not.toMatch(/search_products\(keyword=/);
    expect(text).not.toContain('*A*');
  });

  describe('buildPendingOrderLinesContextLines con línea lista para fulfillment', () => {
    const resolution = (over: Record<string, unknown> = {}) => ({
      resolutionId: 'pr1:biz-1:conv-1:res-1',
      productId: 'prod-ceviche',
      businessId: 'biz-1',
      conversationId: 'conv-1',
      source: 'search_products',
      status: 'selected',
      // resolve_product conserva el scope de la búsqueda: un solo match → turn.
      scope: 'turn',
      turnId: 'turn-anterior',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...over,
    });
    const readyPending = (over: Partial<PendingOrderLines['lines'][number]> = {}) => basePending({
      lines: [
        { id: 'l1', hint: 'ceviche', requestedQuantity: 2, status: 'active', currentResolutionId: 'pr1:biz-1:conv-1:res-1', pendingNote: null, ...over },
        { id: 'l2', hint: 'papas', requestedQuantity: null, status: 'queued', currentResolutionId: null, pendingNote: null },
      ],
    });

    it('expone orderLineId, productId, resolutionId y cantidad persistida sin instrucción de búsqueda', () => {
      const text = buildPendingOrderLinesContextLines({
        pendingOrderLines: readyPending(),
        productResolutions: [resolution()],
      }).join('\n');

      expect(text).toContain('orderLineId: l1');
      expect(text).toContain('productId: prod-ceviche');
      expect(text).toContain('resolutionId: pr1:biz-1:conv-1:res-1');
      expect(text).toContain('quantity: 2');
      expect(text).toContain('add_cart_item(productId="prod-ceviche", resolutionId="pr1:biz-1:conv-1:res-1", orderLineId="l1", quantity=2)');
      expect(text).toContain('*papas* [orderLineId: l2]');
      expect(text).not.toMatch(/search_products\(keyword=/);
    });

    it.each([
      ['sin cantidad conocida', { pendingOrderLines: readyPending({ requestedQuantity: null }), productResolutions: [resolution()] }],
      ['sin ProductResolution en el ledger', { pendingOrderLines: readyPending(), productResolutions: [] }],
      ['ProductResolution consumida', { pendingOrderLines: readyPending(), productResolutions: [resolution({ status: 'consumed' })] }],
      ['ProductResolution vencida', { pendingOrderLines: readyPending(), productResolutions: [resolution({ expiresAt: new Date(Date.now() - 1_000).toISOString() })] }],
      ['ProductResolution pending sin entrada pendiente que la respalde', { pendingOrderLines: readyPending(), productResolutions: [resolution({ scope: 'pending' })] }],
      [
        'ProductResolution también asociada a otra Task',
        {
          pendingOrderLines: basePending({
            lines: [
              { id: 'l1', hint: 'ceviche', requestedQuantity: 2, status: 'active', currentResolutionId: 'pr1:biz-1:conv-1:res-1', pendingNote: null },
              { id: 'l2', hint: 'papas', requestedQuantity: null, status: 'queued', currentResolutionId: 'pr1:biz-1:conv-1:res-1', pendingNote: null },
            ],
          }),
          productResolutions: [resolution()],
        },
      ],
    ])('mantiene la instrucción de búsqueda %s', (_label, metadata) => {
      const text = buildPendingOrderLinesContextLines(metadata).join('\n');
      expect(text).toMatch(/search_products\(keyword="ceviche"\)/);
      expect(text).not.toContain('productId: prod-ceviche');
    });
  });

  it('buildPendingOrderLinesContextLines vacío sin cola', () => {
    expect(buildPendingOrderLinesContextLines({})).toEqual([]);
  });

  describe('resolveOrderLineForProduct', () => {
    const pending = basePending({
      lines: [
        { id: 'l1', hint: 'ceviche', requestedQuantity: 1, status: 'active', currentResolutionId: null, pendingNote: null },
        { id: 'l2', hint: 'papas a la huancaína', requestedQuantity: 2, status: 'queued', currentResolutionId: null, pendingNote: null },
        { id: 'l3', hint: 'una chicha morada', requestedQuantity: 1, status: 'queued', currentResolutionId: null, pendingNote: null },
      ],
    });

    it('matchea la línea por nombre del catálogo, tolerando acentos y plural', () => {
      expect(resolveOrderLineForProduct(pending, 'Ceviche Clásico')).toMatchObject({ id: 'l1' });
      expect(resolveOrderLineForProduct(pending, 'Papa a la huancaina')).toMatchObject({
        id: 'l2',
        requestedQuantity: 2,
      });
      expect(resolveOrderLineForProduct(pending, 'Chicha morada')).toMatchObject({ id: 'l3' });
    });

    it('matchea líneas queued, no solo la activa (drenaje de unívocos D5)', () => {
      expect(resolveOrderLineForProduct(pending, 'Papa a la huancaina')?.status).toBe('queued');
    });

    it('null si el producto no corresponde a ninguna línea abierta', () => {
      expect(resolveOrderLineForProduct(pending, 'Lomo saltado')).toBeNull();
      expect(resolveOrderLineForProduct(pending, 'Flan')).toBeNull();
      expect(resolveOrderLineForProduct(null, 'Ceviche Clásico')).toBeNull();
    });

    it('ignora líneas ya cerradas', () => {
      const closed = basePending({
        lines: [{ id: 'l1', hint: 'ceviche', requestedQuantity: 1, status: 'done', currentResolutionId: null, pendingNote: null }],
      });
      expect(resolveOrderLineForProduct(closed, 'Ceviche Clásico')).toBeNull();
    });

    it('no matchea por stopwords compartidas ("a la", "de")', () => {
      const soloStopwords = basePending({
        lines: [{ id: 'l1', hint: 'papas a la huancaína', requestedQuantity: 2, status: 'active', currentResolutionId: null, pendingNote: null }],
      });
      expect(resolveOrderLineForProduct(soloStopwords, 'Pollo a la brasa')).toBeNull();
    });
  });

  it('getPendingOrderLines lee metadata normalizada', () => {
    expect(getPendingOrderLines({ pendingOrderLines: basePending() })?.lines).toHaveLength(3);
    expect(getPendingOrderLines({})).toBeNull();
  });
});
