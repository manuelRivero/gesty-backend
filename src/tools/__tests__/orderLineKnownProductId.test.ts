/**
 * Preservación de identidad de producto al crear una OrderLine
 * (`plan_order_lines`) + validación temprana en `resolve_product` — ver
 * auditoría del pedido compuesto con resolución incompatible
 * ("Bueno agrega el ceviche y las papas" tras consultar ambos por separado).
 *
 * Invariantes cubiertas:
 * 1. Identidad previa conservada para 2 productos ya identificados.
 * 2. Pedido compuesto: líneas independientes, sin contaminación cruzada.
 * 3. Producto incompatible: resolve_product rechaza ANTES de tocar el ledger.
 * 4. Sin asociación previa: línea sin productId (o sin resolución vigente)
 *    sigue el flujo normal de búsqueda/resolución.
 * 5. Resolución incompatible (resolutionId de otro producto) sigue rechazada.
 * 6. Aislamiento: una resolución de otro negocio/conversación no cuenta.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { database } = vi.hoisted(() => {
  const state = { metadata: {} as Record<string, unknown> };
  const prisma: any = {
    menu_item: {
      findFirst: vi.fn(),
      findMany: vi.fn(async ({ where }: { where: { id?: { in?: string[] } } }) => {
        const ids = where.id?.in;
        return ids ? ids.map((id) => ({ id })) : [];
      }),
    },
    draft_order: {
      findFirst: vi.fn(async () => ({ id: 'draft-1' })),
      create: vi.fn(),
      update: vi.fn(),
    },
    draft_order_item: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'line-1', quantity: 1 })),
      update: vi.fn(),
      aggregate: vi.fn(async () => ({ _sum: { total_price: 0 } })),
      findMany: vi.fn(async () => []),
    },
    business: { findUnique: vi.fn(async () => ({ currency_code: 'ARS' })) },
    conversation_state: {
      upsert: vi.fn(),
      findUnique: vi.fn(async () => ({ metadata: state.metadata })),
      update: vi.fn(async ({ data }: { data: { metadata: Record<string, unknown> } }) => {
        state.metadata = data.metadata;
        return { metadata: state.metadata };
      }),
    },
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('').includes('jsonb_set')) {
        state.metadata.productResolutions = JSON.parse(String(values[0])) as unknown;
      }
      return 1;
    }),
  };
  prisma.$transaction = vi.fn(async (arg: ((tx: typeof prisma) => unknown) | Promise<unknown>[]) =>
    Array.isArray(arg) ? Promise.all(arg) : arg(prisma)
  );
  return { database: { prisma, state } };
});

vi.mock('../../lib/prisma', () => ({ prisma: database.prisma }));
vi.mock('../../services/ordersCapabilityGate.service', () => ({
  assertCanOrder: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../services/partySizeGoal.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/partySizeGoal.service')>();
  return {
    ...actual,
    isPartySizeMissingForOrderingTools: vi.fn().mockReturnValue(false),
    clearPendingPartySizeOrder: vi.fn(),
  };
});
vi.mock('../../repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories')>();
  return {
    ...actual,
    findOrCreateConversationState: vi.fn(async () => ({ metadata: database.state.metadata })),
    patchConversationMetadata: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      database.state.metadata = { ...database.state.metadata, ...patch };
    }),
    omitConversationMetadataKeys: vi.fn(async (_id: string, keys: string[]) => {
      for (const key of keys) delete database.state.metadata[key];
    }),
    mutateConversationMetadata: vi.fn(async (
      _conversationId: string,
      mutate: (metadata: Record<string, unknown>) => { metadata: Record<string, unknown> | null; result: unknown }
    ) => {
      const mutation = mutate(database.state.metadata);
      if (mutation.metadata) database.state.metadata = mutation.metadata;
      return mutation.result;
    }),
  };
});

import { Prisma } from '@prisma/client';
import { addCartItemTool, planOrderLinesTool, resolveProductTool } from '../index';
import { getPendingOrderLines } from '../../services/pendingOrderLines.service';

const BUSINESS_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_BUSINESS_ID = '99999999-9999-4999-8999-999999999999';
const CONVERSATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_CONVERSATION_ID = '88888888-8888-4888-8888-888888888888';
const CEVICHE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PAPAS_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const UNRESOLVED_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const CONFIG = {
  configurable: {
    businessId: BUSINESS_ID,
    customerId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    customerPhone: '+5491100000000',
    conversationId: CONVERSATION_ID,
    conversationStartedAt: new Date().toISOString(),
    turnStartedAt: new Date().toISOString(),
    turnId: 'turn-known-product-id',
    userMessage: 'Bueno agrega el ceviche y las papas',
  },
};

const resolution = (productId: string, over: Record<string, unknown> = {}) => ({
  resolutionId: `pr1:${BUSINESS_ID}:${CONVERSATION_ID}:${productId}-res`,
  productId,
  businessId: BUSINESS_ID,
  conversationId: CONVERSATION_ID,
  source: 'search_products',
  status: 'resolved',
  scope: 'conversation',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...over,
});

const linesOf = () => getPendingOrderLines(database.state.metadata)?.lines ?? [];

describe('preservación de identidad de producto en OrderLine (plan_order_lines + resolve_product)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.state.metadata = { peopleCount: 2, requestedPartySize: 2 };
  });

  it('1+2) pedido compuesto: dos productos ya identificados se asocian a sus respectivas líneas, sin contaminación cruzada', async () => {
    database.state.metadata.productResolutions = [resolution(CEVICHE_ID), resolution(PAPAS_ID)];

    await planOrderLinesTool.func(
      {
        lines: [
          { hint: 'ceviche', productId: CEVICHE_ID },
          { hint: 'papas a la huancaína', productId: PAPAS_ID },
        ],
      },
      undefined,
      CONFIG
    );

    const lines = linesOf();
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.hint === 'ceviche')?.knownProductId).toBe(CEVICHE_ID);
    expect(lines.find((l) => l.hint === 'papas a la huancaína')?.knownProductId).toBe(PAPAS_ID);
    // Sin contaminación cruzada: ninguna línea toma la identidad de la otra.
    expect(lines.find((l) => l.hint === 'ceviche')?.knownProductId).not.toBe(PAPAS_ID);
    expect(lines.find((l) => l.hint === 'papas a la huancaína')?.knownProductId).not.toBe(CEVICHE_ID);
  });

  it('4) sin asociación previa: un productId sin ProductResolution vigente no se preserva — la línea sigue el flujo normal', async () => {
    database.state.metadata.productResolutions = [];

    await planOrderLinesTool.func(
      {
        lines: [
          { hint: 'ceviche', productId: UNRESOLVED_ID },
          { hint: 'papas a la huancaína' },
        ],
      },
      undefined,
      CONFIG
    );

    const lines = linesOf();
    expect(lines.find((l) => l.hint === 'ceviche')?.knownProductId).toBeNull();
    expect(lines.find((l) => l.hint === 'papas a la huancaína')?.knownProductId).toBeNull();
  });

  it('6) aislamiento: una ProductResolution de OTRO negocio/conversación no se preserva como identidad', async () => {
    database.state.metadata.productResolutions = [
      resolution(CEVICHE_ID, { businessId: OTHER_BUSINESS_ID }),
      resolution(PAPAS_ID, { conversationId: OTHER_CONVERSATION_ID }),
    ];

    await planOrderLinesTool.func(
      {
        lines: [
          { hint: 'ceviche', productId: CEVICHE_ID },
          { hint: 'papas a la huancaína', productId: PAPAS_ID },
        ],
      },
      undefined,
      CONFIG
    );

    const lines = linesOf();
    expect(lines.find((l) => l.hint === 'ceviche')?.knownProductId).toBeNull();
    expect(lines.find((l) => l.hint === 'papas a la huancaína')?.knownProductId).toBeNull();
  });

  it('3) producto incompatible: resolve_product rechaza ANTES de tocar el ledger si el productId no es el de la línea', async () => {
    database.state.metadata.productResolutions = [resolution(CEVICHE_ID), resolution(PAPAS_ID)];
    await planOrderLinesTool.func(
      {
        lines: [
          { hint: 'ceviche', productId: CEVICHE_ID },
          { hint: 'papas a la huancaína', productId: PAPAS_ID },
        ],
      },
      undefined,
      CONFIG
    );
    const cevicheLine = linesOf().find((l) => l.hint === 'ceviche')!;
    const papasResolutionId = (database.state.metadata.productResolutions as Array<{ productId: string; resolutionId: string }>)
      .find((r) => r.productId === PAPAS_ID)!.resolutionId;

    const result = JSON.parse(
      (await resolveProductTool.func(
        { productId: PAPAS_ID, resolutionId: papasResolutionId, orderLineId: cevicheLine.id },
        undefined,
        CONFIG
      )) as string
    );

    expect(result).toMatchObject({ success: false, error: 'order_line_product_mismatch' });
    // El ledger no se tocó: la resolución de las papas sigue 'resolved', no 'selected'/'consumed'.
    expect(
      (database.state.metadata.productResolutions as Array<{ resolutionId: string; status: string }>)
        .find((r) => r.resolutionId === papasResolutionId)?.status
    ).toBe('resolved');
  });

  it('5) resolución incompatible: un resolutionId que pertenece a otro producto sigue rechazado (resolution_product_mismatch)', async () => {
    database.state.metadata.productResolutions = [resolution(CEVICHE_ID), resolution(PAPAS_ID)];
    await planOrderLinesTool.func(
      { lines: [{ hint: 'ceviche', productId: CEVICHE_ID }, { hint: 'papas a la huancaína' }] },
      undefined,
      CONFIG
    );
    const cevicheLine = linesOf().find((l) => l.hint === 'ceviche')!;
    const cevicheResolutionId = (database.state.metadata.productResolutions as Array<{ productId: string; resolutionId: string }>)
      .find((r) => r.productId === CEVICHE_ID)!.resolutionId;

    // El modelo pasa el productId correcto de la línea (pasa mi nuevo guard),
    // pero un resolutionId que en el ledger pertenece a OTRO producto (papas) —
    // debe seguir rechazado por la validación existente de productResolution.service.ts.
    const papasResolutionId = (database.state.metadata.productResolutions as Array<{ productId: string; resolutionId: string }>)
      .find((r) => r.productId === PAPAS_ID)!.resolutionId;

    const result = JSON.parse(
      (await resolveProductTool.func(
        { productId: CEVICHE_ID, resolutionId: papasResolutionId, orderLineId: cevicheLine.id },
        undefined,
        CONFIG
      )) as string
    );

    expect(result).toMatchObject({ success: false, reason: 'resolution_product_mismatch' });
    expect(
      (database.state.metadata.productResolutions as Array<{ resolutionId: string; status: string }>)
        .find((r) => r.resolutionId === cevicheResolutionId)?.status
    ).toBe('resolved');
  });

  it('add_cart_item no puede eludir la validación de una línea con producto conocido (camino directo, sin pasar por resolve_product otra vez)', async () => {
    // Ambas líneas YA resueltas legítimamente (cada una via resolve_product,
    // que ya pasó por el guard de knownProductId) — currentResolutionId real
    // asociado a cada Task. El modelo intenta un add_cart_item DIRECTO para la
    // línea del ceviche usando el productId/resolutionId de las PAPAS.
    database.state.metadata.productResolutions = [resolution(CEVICHE_ID), resolution(PAPAS_ID)];
    await planOrderLinesTool.func(
      {
        lines: [
          { hint: 'ceviche', productId: CEVICHE_ID },
          { hint: 'papas a la huancaína', productId: PAPAS_ID },
        ],
      },
      undefined,
      CONFIG
    );
    const cevicheLine = linesOf().find((l) => l.hint === 'ceviche')!;
    const resolutions = database.state.metadata.productResolutions as Array<{ productId: string; resolutionId: string }>;
    const cevicheResolutionId = resolutions.find((r) => r.productId === CEVICHE_ID)!.resolutionId;
    const papasResolutionId = resolutions.find((r) => r.productId === PAPAS_ID)!.resolutionId;
    // Asociación legítima previa (como la dejaría un resolve_product exitoso):
    // el Task del ceviche ya tiene SU PROPIA resolución asociada.
    (database.state.metadata.pendingOrderLines as { lines: Array<{ id: string; currentResolutionId: string | null }> })
      .lines.find((l) => l.id === cevicheLine.id)!.currentResolutionId = cevicheResolutionId;

    vi.mocked(database.prisma.menu_item.findFirst).mockResolvedValue({
      id: PAPAS_ID,
      name: 'Papas a la huancaína',
      business_id: BUSINESS_ID,
      is_available: true,
      variations: [],
      discount_type: null,
      discount_value: null,
      menu_item_price: [{ amount: 100, currency_code: 'ARS' }],
    } as never);

    const result = JSON.parse(
      (await addCartItemTool.func(
        { productId: PAPAS_ID, resolutionId: papasResolutionId, orderLineId: cevicheLine.id, quantity: 1 },
        undefined,
        CONFIG
      )) as string
    );

    expect(result.success).toBe(false);
    // Rechazado por el ownership existente (task.currentResolutionId !== resolutionId
    // pasado) — ni siquiera llega a comparar productId: la Task del ceviche no
    // tiene asociada la resolución de las papas, así que no hay bypass posible
    // sin pasar antes por resolve_product (ya guardado).
    expect(database.prisma.draft_order_item.create).not.toHaveBeenCalled();
  });

  it('permite resolve_product cuando el productId SÍ coincide con la identidad preservada de la línea', async () => {
    database.state.metadata.productResolutions = [resolution(CEVICHE_ID)];
    await planOrderLinesTool.func(
      { lines: [{ hint: 'ceviche', productId: CEVICHE_ID }, { hint: 'papas a la huancaína' }] },
      undefined,
      CONFIG
    );
    const cevicheLine = linesOf().find((l) => l.hint === 'ceviche')!;
    expect(cevicheLine.knownProductId).toBe(CEVICHE_ID);
    const cevicheResolutionId = (database.state.metadata.productResolutions as Array<{ productId: string; resolutionId: string }>)
      .find((r) => r.productId === CEVICHE_ID)!.resolutionId;

    const result = JSON.parse(
      (await resolveProductTool.func(
        { productId: CEVICHE_ID, resolutionId: cevicheResolutionId, orderLineId: cevicheLine.id },
        undefined,
        CONFIG
      )) as string
    );

    expect(result).toMatchObject({ success: true, productId: CEVICHE_ID });
  });

  it('una resolución status:selected (elección explícita previa) también se preserva y es usable para su línea', async () => {
    database.state.metadata.productResolutions = [resolution(CEVICHE_ID, { status: 'selected' })];
    await planOrderLinesTool.func(
      { lines: [{ hint: 'ceviche', productId: CEVICHE_ID }, { hint: 'papas a la huancaína' }] },
      undefined,
      CONFIG
    );
    const cevicheLine = linesOf().find((l) => l.hint === 'ceviche')!;
    expect(cevicheLine.knownProductId).toBe(CEVICHE_ID);

    const result = JSON.parse(
      (await resolveProductTool.func(
        { productId: CEVICHE_ID, resolutionId: (database.state.metadata.productResolutions as Array<{ resolutionId: string }>)[0].resolutionId, orderLineId: cevicheLine.id },
        undefined,
        CONFIG
      )) as string
    );
    expect(result).toMatchObject({ success: true, productId: CEVICHE_ID });
  });

  it('una resolución status:candidate (shortlist todavía sin elegir) NO se preserva como identidad de la línea', async () => {
    database.state.metadata.productResolutions = [resolution(CEVICHE_ID, { status: 'candidate' })];
    await planOrderLinesTool.func(
      { lines: [{ hint: 'ceviche', productId: CEVICHE_ID }, { hint: 'papas a la huancaína' }] },
      undefined,
      CONFIG
    );
    const cevicheLine = linesOf().find((l) => l.hint === 'ceviche')!;
    expect(cevicheLine.knownProductId).toBeNull();
  });

  describe('asociación determinista de currentResolutionId a la línea ACTIVE (bypass de resolución en pedidos auto-creados)', () => {
    it('una resolución status:selected exacta se asocia a currentResolutionId de la línea ACTIVE al crearla', async () => {
      database.state.metadata.productResolutions = [resolution(CEVICHE_ID, { status: 'selected' })];
      await planOrderLinesTool.func(
        { lines: [{ hint: 'ceviche', productId: CEVICHE_ID }, { hint: 'papas a la huancaína' }] },
        undefined,
        CONFIG
      );
      const cevicheLine = linesOf().find((l) => l.hint === 'ceviche')!;
      const cevicheResolutionId = (database.state.metadata.productResolutions as Array<{ productId: string; resolutionId: string }>)
        .find((r) => r.productId === CEVICHE_ID)!.resolutionId;
      expect(cevicheLine.status).toBe('active');
      expect(cevicheLine.currentResolutionId).toBe(cevicheResolutionId);
    });

    it('una resolución status:resolved exacta también se asocia (mismo criterio de elegibilidad que knownProductId)', async () => {
      database.state.metadata.productResolutions = [resolution(CEVICHE_ID, { status: 'resolved' })];
      await planOrderLinesTool.func(
        { lines: [{ hint: 'ceviche', productId: CEVICHE_ID }, { hint: 'papas a la huancaína' }] },
        undefined,
        CONFIG
      );
      const cevicheLine = linesOf().find((l) => l.hint === 'ceviche')!;
      expect(cevicheLine.currentResolutionId).not.toBeNull();
    });

    it('candidate y consumed nunca se auto-asocian a currentResolutionId', async () => {
      database.state.metadata.productResolutions = [resolution(CEVICHE_ID, { status: 'candidate' })];
      await planOrderLinesTool.func(
        { lines: [{ hint: 'ceviche', productId: CEVICHE_ID }, { hint: 'papas a la huancaína' }] },
        undefined,
        CONFIG
      );
      expect(linesOf().find((l) => l.hint === 'ceviche')!.currentResolutionId).toBeNull();

      database.state.metadata = { peopleCount: 2, requestedPartySize: 2 };
      database.state.metadata.productResolutions = [resolution(PAPAS_ID, { status: 'consumed' })];
      await planOrderLinesTool.func(
        { lines: [{ hint: 'papas a la huancaína', productId: PAPAS_ID }, { hint: 'ceviche' }] },
        undefined,
        CONFIG
      );
      expect(linesOf().find((l) => l.hint === 'papas a la huancaína')!.currentResolutionId).toBeNull();
    });

    it('una resolución vencida (TTL) no se asocia', async () => {
      database.state.metadata.productResolutions = [
        resolution(CEVICHE_ID, { status: 'selected', expiresAt: new Date(Date.now() - 1_000).toISOString() }),
      ];
      await planOrderLinesTool.func(
        { lines: [{ hint: 'ceviche', productId: CEVICHE_ID }, { hint: 'papas a la huancaína' }] },
        undefined,
        CONFIG
      );
      expect(linesOf().find((l) => l.hint === 'ceviche')!.currentResolutionId).toBeNull();
    });

    it('una resolución de otra conversación/negocio no se asocia', async () => {
      database.state.metadata.productResolutions = [
        resolution(CEVICHE_ID, { status: 'selected', conversationId: OTHER_CONVERSATION_ID }),
      ];
      await planOrderLinesTool.func(
        { lines: [{ hint: 'ceviche', productId: CEVICHE_ID }, { hint: 'papas a la huancaína' }] },
        undefined,
        CONFIG
      );
      expect(linesOf().find((l) => l.hint === 'ceviche')!.currentResolutionId).toBeNull();
    });

    it('sin identidad confiable (sin productId) no se infiere ninguna asociación por el nombre del hint', async () => {
      database.state.metadata.productResolutions = [resolution(CEVICHE_ID, { status: 'selected' })];
      await planOrderLinesTool.func(
        // El hint menciona "ceviche" en texto libre, pero sin productId: nunca
        // se asocia por coincidencia de nombre.
        { lines: [{ hint: 'ceviche' }, { hint: 'papas a la huancaína' }] },
        undefined,
        CONFIG
      );
      expect(linesOf().find((l) => l.hint === 'ceviche')!.currentResolutionId).toBeNull();
      expect(linesOf().find((l) => l.hint === 'ceviche')!.knownProductId).toBeNull();
    });

    it('la asociación es la que add_cart_item usa vía currentResolutionId: permite agregar directo, sin pasar por resolve_product', async () => {
      database.state.metadata.productResolutions = [resolution(CEVICHE_ID, { status: 'selected' })];
      await planOrderLinesTool.func(
        {
          lines: [
            { hint: 'ceviche', productId: CEVICHE_ID, requestedQuantity: 1 },
            { hint: 'papas a la huancaína' },
          ],
        },
        undefined,
        CONFIG
      );
      const cevicheLine = linesOf().find((l) => l.hint === 'ceviche')!;
      const cevicheResolutionId = (database.state.metadata.productResolutions as Array<{ productId: string; resolutionId: string }>)
        .find((r) => r.productId === CEVICHE_ID)!.resolutionId;

      vi.mocked(database.prisma.menu_item.findFirst).mockResolvedValue({
        id: CEVICHE_ID,
        name: 'Ceviche',
        business_id: BUSINESS_ID,
        is_available: true,
        variations: [],
        discount_type: null,
        discount_value: null,
        menu_item_price: [{ amount: new Prisma.Decimal(100), currency_code: 'ARS' }],
      } as never);

      const result = JSON.parse(
        (await addCartItemTool.func(
          { productId: CEVICHE_ID, resolutionId: cevicheResolutionId, orderLineId: cevicheLine.id, quantity: 1 },
          undefined,
          CONFIG
        )) as string
      );

      expect(result.success).toBe(true);
    });
  });
});
