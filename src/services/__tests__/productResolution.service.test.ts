import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeDb } = vi.hoisted(() => {
  const state = { metadata: {} as Record<string, unknown> };
  const menuItem = {
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id) => ({ id }))
    ),
  };
  const tx = {
    menu_item: menuItem,
    conversation_state: {
      upsert: vi.fn(),
      findUnique: vi.fn(async () => ({ metadata: state.metadata })),
    },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      state.metadata.productResolutions = JSON.parse(String(values[0])) as unknown;
      return 1;
    }),
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    conversation_state: tx.conversation_state,
  };
  return { fakeDb: { state, tx, prisma } };
});

vi.mock('../../lib/prisma', () => ({ prisma: fakeDb.prisma }));

import {
  consumeProductResolution,
  expireOpenProductResolutions,
  extendProductResolutionForPending,
  getProductResolutions,
  issueProductResolutions,
  listRecentEligibleProductResolutions,
  listRecentProductResolutions,
  selectProductResolution,
  selectProductResolutionFromButton,
  type ProductResolution,
} from '../productResolution.service';

const BUSINESS_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_BUSINESS_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONVERSATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_CONVERSATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PRODUCT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_PRODUCT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const issue = async (overrides: Partial<Parameters<typeof issueProductResolutions>[0]> = {}) => {
  const [resolution] = await issueProductResolutions({
    productIds: [PRODUCT_ID],
    businessId: BUSINESS_ID,
    conversationId: CONVERSATION_ID,
    source: 'search_products',
    status: 'resolved',
    scope: 'conversation',
    ...overrides,
  });
  return resolution;
};

const consume = (params: {
  productId?: string;
  businessId?: string;
  conversationId?: string;
  resolutionId?: string;
  turnId?: string;
  pendingResolutionId?: string;
  orderLineId?: string;
}) =>
  consumeProductResolution(fakeDb.tx as never, {
    productId: params.productId ?? PRODUCT_ID,
    businessId: params.businessId ?? BUSINESS_ID,
    conversationId: params.conversationId ?? CONVERSATION_ID,
    resolutionId: params.resolutionId,
    turnId: params.turnId,
    pendingResolutionId: params.pendingResolutionId,
    orderLineId: params.orderLineId,
  });

describe('ProductResolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeDb.state.metadata = {};
    fakeDb.tx.menu_item.findMany.mockImplementation(async ({ where }) =>
      where.id.in.map((id) => ({ id }))
    );
  });

  it('rechaza un UUID válido sin resolución', async () => {
    await expect(consume({})).resolves.toMatchObject({ ok: false, reason: 'resolution_missing' });
  });

  it('rechaza una resolución de otro negocio y otra conversación', async () => {
    const resolution = await issue();
    await expect(
      consume({ resolutionId: resolution.resolutionId, businessId: OTHER_BUSINESS_ID })
    ).resolves.toMatchObject({ ok: false, reason: 'resolution_wrong_business' });
    await expect(
      consume({ resolutionId: resolution.resolutionId, conversationId: OTHER_CONVERSATION_ID })
    ).resolves.toMatchObject({ ok: false, reason: 'resolution_wrong_conversation' });
  });

  it('rechaza una resolución expirada o para otro productId', async () => {
    const expired = await issue({ expiresAt: '2000-01-01T00:00:00.000Z' });
    await expect(consume({ resolutionId: expired.resolutionId })).resolves.toMatchObject({
      ok: false,
      reason: 'resolution_expired',
    });

    const current = await issue();
    await expect(
      consume({ resolutionId: current.resolutionId, productId: OTHER_PRODUCT_ID })
    ).resolves.toMatchObject({ ok: false, reason: 'resolution_product_mismatch' });
  });

  it('no trata un candidate ambiguo como autorización hasta selección', async () => {
    const candidate = await issue({ status: 'candidate' });
    await expect(consume({ resolutionId: candidate.resolutionId })).resolves.toMatchObject({
      ok: false,
      reason: 'resolution_not_selected',
    });

    const selected = await selectProductResolution({
      productId: PRODUCT_ID,
      resolutionId: candidate.resolutionId,
      businessId: BUSINESS_ID,
      conversationId: CONVERSATION_ID,
      explicitButtonSelection: true,
    });
    expect(selected.ok).toBe(true);
    await expect(consume({ resolutionId: candidate.resolutionId })).resolves.toMatchObject({
      ok: true,
    });
  });

  it('promueve un candidato solo al recibir selección desde un botón', async () => {
    await issue({ status: 'candidate', source: 'whatsapp_presentation' });
    const selected = await selectProductResolutionFromButton({
      productId: PRODUCT_ID,
      businessId: BUSINESS_ID,
      conversationId: CONVERSATION_ID,
    });
    expect(selected).toMatchObject({ ok: true, resolution: { status: 'selected' } });
    await expect(consume({ resolutionId: selected.ok ? selected.resolution.resolutionId : '' }))
      .resolves.toMatchObject({ ok: true });
  });

  it('consume una resolución una sola vez y conserva el tombstone', async () => {
    const resolution = await issue();
    await expect(consume({ resolutionId: resolution.resolutionId })).resolves.toMatchObject({
      ok: true,
      resolution: { status: 'consumed' },
    });
    await expect(consume({ resolutionId: resolution.resolutionId })).resolves.toMatchObject({
      ok: false,
      reason: 'resolution_consumed',
    });
  });

  it('requiere Task ID con cola abierta y rechaza consumir la resolución de otra Task', async () => {
    const resolutionA = await issue();
    const resolutionB = await issue();
    fakeDb.state.metadata.pendingOrderLines = {
      lines: [
        { id: 'task-a', hint: 'ceviche', requestedQuantity: 2, status: 'active', currentResolutionId: resolutionA.resolutionId },
        { id: 'task-b', hint: 'ceviche', requestedQuantity: 1, status: 'queued', currentResolutionId: resolutionB.resolutionId },
      ],
      sourceMessage: 'mismo producto, Tasks independientes',
      createdAt: new Date().toISOString(),
    };

    await expect(consume({ resolutionId: resolutionA.resolutionId })).resolves.toMatchObject({
      ok: false,
      reason: 'order_line_id_required',
    });
    await expect(consume({
      resolutionId: resolutionA.resolutionId,
      orderLineId: 'task-b',
    })).resolves.toMatchObject({ ok: false, reason: 'task_resolution_mismatch' });
    expect(fakeDb.state.metadata.productResolutions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resolutionId: resolutionA.resolutionId, status: 'resolved' }),
        expect.objectContaining({ resolutionId: resolutionB.resolutionId, status: 'resolved' }),
      ])
    );
  });

  it('extiende cantidad/variación pendiente sin consumir la resolución', async () => {
    const resolution = await issue({ scope: 'turn', turnId: 'turn-1' });
    await expect(
      consume({ resolutionId: resolution.resolutionId, turnId: 'turn-2' })
    ).resolves.toMatchObject({ ok: false, reason: 'resolution_expired' });

    fakeDb.state.metadata.pendingAddQuantity = {
      productId: PRODUCT_ID,
      productResolutionId: resolution.resolutionId,
    };
    await expect(
      extendProductResolutionForPending({
        resolutionId: resolution.resolutionId,
        productId: PRODUCT_ID,
        conversationId: CONVERSATION_ID,
      })
    ).resolves.toBe(true);
    delete fakeDb.state.metadata.pendingAddQuantity;
    await expect(
      consume({
        resolutionId: resolution.resolutionId,
        pendingResolutionId: resolution.resolutionId,
      })
    ).resolves.toMatchObject({ ok: false, reason: 'resolution_expired' });
    fakeDb.state.metadata.pendingAddQuantity = {
      productId: PRODUCT_ID,
      productResolutionId: resolution.resolutionId,
    };
    await expect(
      consume({
        resolutionId: resolution.resolutionId,
        pendingResolutionId: resolution.resolutionId,
      })
    ).resolves.toMatchObject({ ok: true, resolution: { status: 'consumed' } });
  });
});

describe('revocación de ProductResolution al invalidarse la oferta (source: last_offer)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeDb.state.metadata = {};
    fakeDb.tx.menu_item.findMany.mockImplementation(async ({ where }) =>
      where.id.in.map((id) => ({ id }))
    );
  });

  it('con el Ledger CONFIRMAR_OFERTA apuntando al mismo producto, la resolución last_offer autoriza el add (no-regresión: aceptación válida)', async () => {
    const resolution = await issue({ source: 'last_offer' });
    fakeDb.state.metadata.intentLedger = { CONFIRMAR_OFERTA: { productId: PRODUCT_ID } };
    await expect(consume({ resolutionId: resolution.resolutionId })).resolves.toMatchObject({
      ok: true,
      resolution: { status: 'consumed' },
    });
  });

  it('limpiar la oferta (Ledger CONFIRMAR_OFERTA vacío, como hace clearLastOffer) invalida la resolución last_offer de ese producto', async () => {
    const resolution = await issue({ source: 'last_offer' });
    fakeDb.state.metadata.intentLedger = { CONFIRMAR_OFERTA: { productId: PRODUCT_ID } };
    // Rechazo: clearLastOffer hace patchIntentLedgerEntry(conv, 'CONFIRMAR_OFERTA', {}).
    fakeDb.state.metadata.intentLedger = { CONFIRMAR_OFERTA: {} };
    await expect(consume({ resolutionId: resolution.resolutionId })).resolves.toMatchObject({
      ok: false,
      reason: 'resolution_offer_invalidated',
    });
  });

  it('sin ningún Ledger CONFIRMAR_OFERTA en absoluto (nunca hubo oferta, o ya se limpió del todo), la resolución last_offer tampoco autoriza', async () => {
    const resolution = await issue({ source: 'last_offer' });
    // metadata.intentLedger ausente por completo.
    await expect(consume({ resolutionId: resolution.resolutionId })).resolves.toMatchObject({
      ok: false,
      reason: 'resolution_offer_invalidated',
    });
  });

  it('una oferta nueva que reemplaza a la anterior invalida la resolución last_offer del producto reemplazado, sin depender de qué tool hizo el reemplazo', async () => {
    const resolutionX = await issue({ source: 'last_offer' });
    fakeDb.state.metadata.intentLedger = { CONFIRMAR_OFERTA: { productId: PRODUCT_ID } };

    // persistLastOffer(Y) reemplaza el Ledger por el producto nuevo — mismo
    // efecto esté detrás de clear_last_offer, de una oferta nueva, o de
    // cualquier otro mecanismo que el ReAct decida invocar.
    fakeDb.state.metadata.intentLedger = { CONFIRMAR_OFERTA: { productId: OTHER_PRODUCT_ID } };

    await expect(consume({ resolutionId: resolutionX.resolutionId })).resolves.toMatchObject({
      ok: false,
      reason: 'resolution_offer_invalidated',
    });
  });

  it('no-regresión: una resolución independiente (search_products) para el mismo producto sigue autorizando aunque la oferta se haya rechazado/reemplazado', async () => {
    const independent = await issue({ source: 'search_products' });
    fakeDb.state.metadata.intentLedger = { CONFIRMAR_OFERTA: {} };
    await expect(consume({ resolutionId: independent.resolutionId })).resolves.toMatchObject({
      ok: true,
      resolution: { status: 'consumed' },
    });
  });

  it('no-regresión: revocar la oferta de un producto no afecta una resolución last_offer vigente de otro producto', async () => {
    const resolutionX = await issue({ source: 'last_offer' });
    const resolutionOther = await issue({ productIds: [OTHER_PRODUCT_ID], source: 'last_offer' });
    // Ledger actual: la oferta vigente es la del otro producto (reemplazo de X por OTHER).
    fakeDb.state.metadata.intentLedger = { CONFIRMAR_OFERTA: { productId: OTHER_PRODUCT_ID } };

    await expect(consume({ resolutionId: resolutionX.resolutionId })).resolves.toMatchObject({
      ok: false,
      reason: 'resolution_offer_invalidated',
    });
    await expect(
      consume({ resolutionId: resolutionOther.resolutionId, productId: OTHER_PRODUCT_ID })
    ).resolves.toMatchObject({ ok: true, resolution: { status: 'consumed' } });
  });

  it('selectProductResolution (el paso previo a consumir) también rechaza una resolución last_offer cuya oferta ya no está en el Ledger', async () => {
    const resolution = await issue({ source: 'last_offer' });
    // Ledger vacío: nunca hubo oferta vigente para este productId.
    await expect(
      selectProductResolution({
        productId: PRODUCT_ID,
        resolutionId: resolution.resolutionId,
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      })
    ).resolves.toMatchObject({ ok: false, reason: 'resolution_offer_invalidated' });
  });
});

describe('expireOpenProductResolutions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeDb.state.metadata = {};
    fakeDb.tx.menu_item.findMany.mockImplementation(async ({ where }) =>
      where.id.in.map((id) => ({ id }))
    );
  });

  it('expira (no borra) una resolución resolved/selected/candidate, pero no toca las consumed', async () => {
    const live = await issue({ status: 'resolved' });
    const consumed = (await consume({ resolutionId: live.resolutionId })) as {
      ok: true;
      resolution: typeof live;
    };
    expect(consumed.ok).toBe(true);
    const other = await issue({ productIds: [OTHER_PRODUCT_ID], status: 'candidate' });

    await expireOpenProductResolutions(CONVERSATION_ID);

    const all = await getProductResolutions(CONVERSATION_ID);
    const consumedAfter = all.find((r) => r.resolutionId === consumed.resolution.resolutionId);
    const candidateAfter = all.find((r) => r.resolutionId === other.resolutionId);
    // La consumed no se toca: sigue con su propio expiresAt (o el que tenía).
    expect(consumedAfter?.status).toBe('consumed');
    expect(consumedAfter?.expiresAt).toBe(consumed.resolution.expiresAt);
    // La no-consumed queda expirada (en el pasado), nunca borrada del array.
    expect(candidateAfter?.status).toBe('candidate');
    expect(candidateAfter?.expiresAt).not.toBeNull();
    expect(Date.parse(candidateAfter!.expiresAt as string)).toBeLessThanOrEqual(Date.now());
  });

  it('una resolución ya expirada, tras agregar al carrito el producto, deja de autorizar un nuevo add', async () => {
    const resolution = await issue({ status: 'resolved' });
    await expireOpenProductResolutions(CONVERSATION_ID);

    await expect(consume({ resolutionId: resolution.resolutionId })).resolves.toMatchObject({
      ok: false,
      reason: 'resolution_expired',
    });
  });

  it('idempotente: sin resoluciones en la conversación, no lanza y no escribe nada', async () => {
    await expect(expireOpenProductResolutions(CONVERSATION_ID)).resolves.toBeUndefined();
    expect(fakeDb.tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('idempotente: llamarla dos veces seguidas no cambia el resultado de la segunda vez', async () => {
    await issue({ status: 'candidate' });
    await expireOpenProductResolutions(CONVERSATION_ID);
    const afterFirst = await getProductResolutions(CONVERSATION_ID);

    await expireOpenProductResolutions(CONVERSATION_ID);
    const afterSecond = await getProductResolutions(CONVERSATION_ID);

    expect(afterSecond).toEqual(afterFirst);
  });
});

describe('listRecentEligibleProductResolutions — proyección plural de productos recientes', () => {
  const FUTURE = new Date(Date.now() + 60_000).toISOString();
  const PAST = new Date(Date.now() - 60_000).toISOString();
  const CEVICHE_ID = '11111111-1111-4111-8111-111111111111';
  const PAPAS_ID = '22222222-2222-4222-8222-222222222222';

  const entry = (over: Partial<ProductResolution> = {}): ProductResolution => ({
    resolutionId: `pr1:${BUSINESS_ID}:${CONVERSATION_ID}:${Math.random().toString(36).slice(2)}`,
    productId: CEVICHE_ID,
    businessId: BUSINESS_ID,
    conversationId: CONVERSATION_ID,
    source: 'search_products',
    status: 'resolved',
    scope: 'conversation',
    createdAt: new Date().toISOString(),
    expiresAt: FUTURE,
    ...over,
  });

  it('1) dos productos identificados en turnos distintos aparecen simultáneamente', () => {
    const result = listRecentEligibleProductResolutions(
      [entry({ productId: CEVICHE_ID, createdAt: '2026-01-01T00:00:00.000Z' }),
       entry({ productId: PAPAS_ID, createdAt: '2026-01-02T00:00:00.000Z' })],
      { businessId: BUSINESS_ID, conversationId: CONVERSATION_ID }
    );
    expect(result.map((r) => r.productId).sort()).toEqual([CEVICHE_ID, PAPAS_ID].sort());
  });

  it('2) selected prevalece sobre resolved para el mismo producto', () => {
    const result = listRecentEligibleProductResolutions(
      [
        entry({ productId: CEVICHE_ID, status: 'resolved', createdAt: '2026-01-02T00:00:00.000Z' }),
        entry({ productId: CEVICHE_ID, status: 'selected', createdAt: '2026-01-01T00:00:00.000Z' }),
      ],
      { businessId: BUSINESS_ID, conversationId: CONVERSATION_ID }
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ status: 'selected' });
  });

  it('en empate de status, prevalece la más reciente', () => {
    const result = listRecentEligibleProductResolutions(
      [
        entry({ productId: CEVICHE_ID, status: 'resolved', createdAt: '2026-01-01T00:00:00.000Z', resolutionId: 'old' }),
        entry({ productId: CEVICHE_ID, status: 'resolved', createdAt: '2026-01-02T00:00:00.000Z', resolutionId: 'new' }),
      ],
      { businessId: BUSINESS_ID, conversationId: CONVERSATION_ID }
    );
    expect(result).toHaveLength(1);
    expect(result[0].resolutionId).toBe('new');
  });

  it('3) una resolución vencida no aparece', () => {
    const result = listRecentEligibleProductResolutions(
      [entry({ expiresAt: PAST })],
      { businessId: BUSINESS_ID, conversationId: CONVERSATION_ID }
    );
    expect(result).toHaveLength(0);
  });

  it('4) una referencia de otro negocio o conversación no aparece', () => {
    const result = listRecentEligibleProductResolutions(
      [
        entry({ productId: CEVICHE_ID, businessId: OTHER_BUSINESS_ID }),
        entry({ productId: PAPAS_ID, conversationId: OTHER_CONVERSATION_ID }),
      ],
      { businessId: BUSINESS_ID, conversationId: CONVERSATION_ID }
    );
    expect(result).toHaveLength(0);
  });

  it('6) respeta el límite, priorizando selected y luego recencia', () => {
    const entries = [
      entry({ productId: '1', status: 'resolved', createdAt: '2026-01-01T00:00:00.000Z' }),
      entry({ productId: '2', status: 'resolved', createdAt: '2026-01-02T00:00:00.000Z' }),
      entry({ productId: '3', status: 'selected', createdAt: '2026-01-03T00:00:00.000Z' }),
      entry({ productId: '4', status: 'resolved', createdAt: '2026-01-04T00:00:00.000Z' }),
      entry({ productId: '5', status: 'selected', createdAt: '2026-01-05T00:00:00.000Z' }),
      entry({ productId: '6', status: 'resolved', createdAt: '2026-01-06T00:00:00.000Z' }),
    ];
    const result = listRecentEligibleProductResolutions(
      entries,
      { businessId: BUSINESS_ID, conversationId: CONVERSATION_ID, limit: 5 }
    );
    expect(result).toHaveLength(5);
    // Los dos `selected` (3 y 5) primero, por recencia entre ellos; luego los
    // `resolved` más recientes hasta completar el límite (6, 4 — el más viejo, 1, queda afuera).
    expect(result.map((r) => r.productId)).toEqual(['5', '3', '6', '4', '2']);
  });

  it('8) consumed no aparece — no por "producto irrelevante", sino porque esa resolutionId puntual ya no es reutilizable (ver comentario en el código)', () => {
    const result = listRecentEligibleProductResolutions(
      [entry({ status: 'consumed' })],
      { businessId: BUSINESS_ID, conversationId: CONVERSATION_ID }
    );
    expect(result).toHaveLength(0);
  });

  it('candidate (shortlist ambiguo, sin resolver) tampoco aparece', () => {
    const result = listRecentEligibleProductResolutions(
      [entry({ status: 'candidate' })],
      { businessId: BUSINESS_ID, conversationId: CONVERSATION_ID }
    );
    expect(result).toHaveLength(0);
  });

  it('listRecentProductResolutions (async) resuelve el ledger real de la conversación', async () => {
    await issue({ status: 'selected' });
    const result = await listRecentProductResolutions({
      businessId: BUSINESS_ID,
      conversationId: CONVERSATION_ID,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ productId: PRODUCT_ID, status: 'selected' });
  });
});