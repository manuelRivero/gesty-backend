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
  extendProductResolutionForPending,
  issueProductResolutions,
  selectProductResolution,
  selectProductResolutionFromButton,
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
}) =>
  consumeProductResolution(fakeDb.tx as never, {
    productId: params.productId ?? PRODUCT_ID,
    businessId: params.businessId ?? BUSINESS_ID,
    conversationId: params.conversationId ?? CONVERSATION_ID,
    resolutionId: params.resolutionId,
    turnId: params.turnId,
    pendingResolutionId: params.pendingResolutionId,
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