import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateNextOrderLine,
  advanceAfterLineClose,
  buildOrderLinesContinueOrCancelHint,
  buildPendingOrderLinesContextLines,
  cancelOrderLine,
  clearPendingOrderLines,
  getActiveOrderLine,
  getPendingOrderLines,
  hasOpenOrderLines,
  ORDER_LINES_MAX,
  parsePendingOrderLines,
  resolveOrderLineForProduct,
  setPendingOrderLines,
  type PendingOrderLines,
} from '../pendingOrderLines.service';

const patchConversationMetadata = vi.fn();
const omitConversationMetadataKeys = vi.fn();

vi.mock('../../repositories', () => ({
  patchConversationMetadata: (...args: unknown[]) => patchConversationMetadata(...args),
  omitConversationMetadataKeys: (...args: unknown[]) => omitConversationMetadataKeys(...args),
}));

const basePending = (over: Partial<PendingOrderLines> = {}): PendingOrderLines => ({
  lines: [
    { id: 'l1', hint: 'lomo saltado', requestedQuantity: 3, status: 'active' },
    { id: 'l2', hint: 'ceviche', requestedQuantity: 2, status: 'queued' },
    { id: 'l3', hint: 'bebida', requestedQuantity: null, status: 'queued' },
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
        { id: 'l1', hint: 'lomo', requestedQuantity: null, status: 'done' },
        { id: 'l2', hint: 'ceviche', requestedQuantity: null, status: 'queued' },
      ],
    });
    expect(getActiveOrderLine(noActive)).toMatchObject({ id: 'l2', status: 'queued' });
    expect(getActiveOrderLine(null)).toBeNull();
  });

  it('hasOpenOrderLines: true con queued/active, false con todo done/cancelled o sin cola', () => {
    expect(hasOpenOrderLines({ pendingOrderLines: basePending() })).toBe(true);
    expect(hasOpenOrderLines({})).toBe(false);
    expect(
      hasOpenOrderLines({
        pendingOrderLines: basePending({
          lines: [
            { id: 'l1', hint: 'lomo', requestedQuantity: null, status: 'done' },
            { id: 'l2', hint: 'ceviche', requestedQuantity: null, status: 'cancelled' },
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
    expect(pending.lines[1]).toMatchObject({ hint: 'ceviche', status: 'queued' });
    expect(patchConversationMetadata).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ pendingOrderLines: expect.any(Object) })
    );
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

  it('advanceAfterLineClose cierra la línea activa y deja la próxima en queued (D6, no active)', async () => {
    const next = await advanceAfterLineClose({
      conversationId: 'conv-1',
      metadata: { pendingOrderLines: basePending() },
      closeStatus: 'done',
    });
    expect(next?.lines.find((l) => l.id === 'l1')?.status).toBe('done');
    expect(next?.lines.find((l) => l.id === 'l2')?.status).toBe('queued');
    // D1: sin línea `active` explícita, la derivación cae a la primera `queued`
    // (el código recién la marca `active` de verdad al llamar activateNextOrderLine).
    expect(getActiveOrderLine(next)).toMatchObject({ id: 'l2', status: 'queued' });
  });

  it('advanceAfterLineClose limpia la cola entera cuando no queda nada abierto', async () => {
    const oneLine = basePending({
      lines: [{ id: 'l1', hint: 'lomo', requestedQuantity: null, status: 'active' }],
    });
    const next = await advanceAfterLineClose({
      conversationId: 'conv-1',
      metadata: { pendingOrderLines: oneLine },
      closeStatus: 'done',
    });
    expect(next).toBeNull();
    expect(omitConversationMetadataKeys).toHaveBeenCalledWith('conv-1', ['pendingOrderLines']);
  });

  it('activateNextOrderLine activa la próxima queued solo si no hay ya una active', async () => {
    const noActive = basePending({
      lines: [
        { id: 'l1', hint: 'lomo', requestedQuantity: null, status: 'done' },
        { id: 'l2', hint: 'ceviche', requestedQuantity: null, status: 'queued' },
      ],
    });
    const next = await activateNextOrderLine('conv-1', { pendingOrderLines: noActive });
    expect(next?.lines.find((l) => l.id === 'l2')?.status).toBe('active');

    patchConversationMetadata.mockClear();
    const alreadyActive = basePending();
    const unchanged = await activateNextOrderLine('conv-1', { pendingOrderLines: alreadyActive });
    expect(unchanged).toEqual(alreadyActive);
    expect(patchConversationMetadata).not.toHaveBeenCalled();
  });

  it('cancelOrderLine cancela por hint o por línea activa', async () => {
    const next = await cancelOrderLine({
      conversationId: 'conv-1',
      metadata: { pendingOrderLines: basePending() },
      hint: 'ceviche',
    });
    expect(next?.lines.find((l) => l.id === 'l2')?.status).toBe('cancelled');
    expect(next?.lines.find((l) => l.id === 'l1')?.status).toBe('active');
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
  });

  it('buildOrderLinesContinueOrCancelHint es null sin líneas queued', () => {
    const allClosed = basePending({
      lines: [{ id: 'l1', hint: 'lomo', requestedQuantity: null, status: 'active' }],
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
    expect(text).toMatch(/PROHIBIDO ofrecer complementos/);
  });

  it('buildPendingOrderLinesContextLines vacío sin cola', () => {
    expect(buildPendingOrderLinesContextLines({})).toEqual([]);
  });

  describe('resolveOrderLineForProduct', () => {
    const pending = basePending({
      lines: [
        { id: 'l1', hint: 'ceviche', requestedQuantity: 1, status: 'active' },
        { id: 'l2', hint: 'papas a la huancaína', requestedQuantity: 2, status: 'queued' },
        { id: 'l3', hint: 'una chicha morada', requestedQuantity: 1, status: 'queued' },
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
        lines: [{ id: 'l1', hint: 'ceviche', requestedQuantity: 1, status: 'done' }],
      });
      expect(resolveOrderLineForProduct(closed, 'Ceviche Clásico')).toBeNull();
    });

    it('no matchea por stopwords compartidas ("a la", "de")', () => {
      const soloStopwords = basePending({
        lines: [{ id: 'l1', hint: 'papas a la huancaína', requestedQuantity: 2, status: 'active' }],
      });
      expect(resolveOrderLineForProduct(soloStopwords, 'Pollo a la brasa')).toBeNull();
    });
  });

  it('getPendingOrderLines lee metadata normalizada', () => {
    expect(getPendingOrderLines({ pendingOrderLines: basePending() })?.lines).toHaveLength(3);
    expect(getPendingOrderLines({})).toBeNull();
  });
});
