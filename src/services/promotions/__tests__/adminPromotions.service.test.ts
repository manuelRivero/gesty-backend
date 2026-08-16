/**
 * CRUD de promociones: transacción, aislamiento por negocio (D10), gate de
 * completitud (D6) y mapeo a DTO del panel.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma', () => {
  const tx = {
    promotion: {
      create: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    promotion_product: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
  return {
    prisma: {
      $transaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)),
      promotion: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        update: vi.fn(),
      },
      menu_item: { findMany: vi.fn() },
      __tx: tx,
    },
  };
});

import { prisma } from '../../../lib/prisma';
import {
  archivePromotion,
  createPromotion,
  getPromotionById,
  listPromotions,
  PromotionForeignProductError,
  PromotionNotFoundError,
  updatePromotion,
} from '../adminPromotions.service';
import { PromotionIncompleteError } from '../promotionStatus';

const tx = (prisma as unknown as { __tx: Record<string, any> }).__tx;
const mockedMenuItems = prisma.menu_item.findMany as unknown as ReturnType<typeof vi.fn>;
const mockedFindFirst = prisma.promotion.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedFindMany = prisma.promotion.findMany as unknown as ReturnType<typeof vi.fn>;
const mockedCount = prisma.promotion.count as unknown as ReturnType<typeof vi.fn>;

const offer = {
  name: 'Martes de hamburguesas',
  conditions: [
    {
      field: 'cart.product',
      operator: 'gte',
      value: { productName: 'hamburguesa', quantity: 1 },
    },
  ],
  benefit: { type: 'free_product', productName: 'papas fritas', quantity: 1 },
  validity: { daysOfWeek: [2], timeRange: { from: '18:00', to: '20:00' } },
};

const productLinks = [
  {
    path: 'offer.conditions[0].value.productName',
    role: 'condition' as const,
    menuItemId: '11111111-1111-1111-1111-111111111111',
    sourceText: 'hamburguesa',
    quantity: 1,
  },
  {
    path: 'offer.benefit.productName',
    role: 'benefit' as const,
    menuItemId: '22222222-2222-2222-2222-222222222222',
    sourceText: 'papas fritas',
    quantity: 1,
  },
];

function promotionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'promo-1',
    business_id: 'biz-1',
    name: 'Martes de hamburguesas',
    status: 'draft',
    offer,
    benefit_type: 'free_product',
    starts_at: null,
    ends_at: null,
    days_of_week: [2],
    time_from: '18:00',
    time_to: '20:00',
    source_type: 'audio',
    source_text: 'Los martes de 18 a 20…',
    created_by: 'user-1',
    created_at: new Date('2026-08-15T18:00:00Z'),
    updated_at: new Date('2026-08-15T18:00:00Z'),
    products: [
      {
        id: 'link-1',
        promotion_id: 'promo-1',
        menu_item_id: '11111111-1111-1111-1111-111111111111',
        role: 'condition',
        offer_path: 'offer.conditions[0].value.productName',
        source_text: 'hamburguesa',
        quantity: 1,
        created_at: new Date(),
        menu_item: {
          id: '11111111-1111-1111-1111-111111111111',
          name: 'Hamburguesa clásica',
          image: 'https://cdn/h.jpg',
        },
      },
      {
        id: 'link-2',
        promotion_id: 'promo-1',
        menu_item_id: '22222222-2222-2222-2222-222222222222',
        role: 'benefit',
        offer_path: 'offer.benefit.productName',
        source_text: 'papas fritas',
        quantity: 1,
        created_at: new Date(),
        menu_item: {
          id: '22222222-2222-2222-2222-222222222222',
          name: 'Papas rústicas',
          image: null,
        },
      },
    ],
    ...overrides,
  };
}

describe('createPromotion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedMenuItems.mockResolvedValue([
      { id: '11111111-1111-1111-1111-111111111111' },
      { id: '22222222-2222-2222-2222-222222222222' },
    ]);
    tx.promotion.create.mockResolvedValue({ id: 'promo-1' });
    tx.promotion.findUniqueOrThrow.mockResolvedValue(promotionRow());
  });

  it('persiste la promo con sus links y deriva las columnas escalares', async () => {
    const dto = await createPromotion({
      businessId: 'biz-1',
      userId: 'user-1',
      offer,
      productLinks,
      sourceType: 'audio',
      sourceText: 'Los martes de 18 a 20…',
    });

    expect(tx.promotion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          business_id: 'biz-1',
          status: 'draft',
          benefit_type: 'free_product',
          days_of_week: [2],
          time_from: '18:00',
          time_to: '20:00',
          source_type: 'audio',
        }),
      })
    );
    expect(tx.promotion_product.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            promotion_id: 'promo-1',
            offer_path: 'offer.benefit.productName',
            role: 'benefit',
          }),
        ]),
      })
    );
    expect(dto.status).toBe('draft');
    expect(dto.statusLabel).toBe('Borrador');
    expect(dto.summaryLine).toBe('Regalo: papas fritas · Martes · 18:00 a 20:00');
    expect(dto.products.map((p) => p.name)).toEqual([
      'Hamburguesa clásica',
      'Papas rústicas',
    ]);
    expect(dto.display.conditions[0]?.label).toBe('Si compra hamburguesa');
  });

  it('rechaza guardar una promo con productos sin vincular (D6)', async () => {
    await expect(
      createPromotion({ businessId: 'biz-1', offer, productLinks: [] })
    ).rejects.toBeInstanceOf(PromotionIncompleteError);
    expect(tx.promotion.create).not.toHaveBeenCalled();
  });

  it('rechaza un menuItemId de otro negocio (D10)', async () => {
    mockedMenuItems.mockResolvedValueOnce([
      { id: '11111111-1111-1111-1111-111111111111' },
    ]);

    await expect(
      createPromotion({ businessId: 'biz-1', offer, productLinks })
    ).rejects.toBeInstanceOf(PromotionForeignProductError);
    expect(tx.promotion.create).not.toHaveBeenCalled();
  });

  it('permite crear directamente activa', async () => {
    tx.promotion.findUniqueOrThrow.mockResolvedValueOnce(
      promotionRow({ status: 'active' })
    );

    const dto = await createPromotion({
      businessId: 'biz-1',
      offer,
      productLinks,
      status: 'active',
    });

    expect(dto.status).toBe('active');
    expect(dto.statusLabel).toBe('Activa');
  });
});

describe('listPromotions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFindMany.mockResolvedValue([promotionRow()]);
    mockedCount.mockResolvedValue(1);
  });

  it('pagina y excluye archivadas por defecto', async () => {
    const result = await listPromotions({ businessId: 'biz-1' });

    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { business_id: 'biz-1', status: { not: 'archived' } },
        skip: 0,
        take: 20,
        orderBy: { created_at: 'desc' },
      })
    );
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20, totalPages: 1 });
    expect(result.items[0]?.summaryLine).toContain('Regalo: papas fritas');
  });

  it('filtra por status y por nombre', async () => {
    await listPromotions({ businessId: 'biz-1', status: 'active', q: 'martes' });

    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          business_id: 'biz-1',
          status: 'active',
          name: { contains: 'martes', mode: 'insensitive' },
        },
      })
    );
  });

  it('respeta el tope de pageSize', async () => {
    await listPromotions({ businessId: 'biz-1', pageSize: 5000 });
    expect(mockedFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });
});

describe('getPromotionById', () => {
  beforeEach(() => vi.clearAllMocks());

  it('404 si la promo es de otro negocio', async () => {
    mockedFindFirst.mockResolvedValueOnce(null);
    await expect(
      getPromotionById({ businessId: 'biz-2', id: 'promo-1' })
    ).rejects.toBeInstanceOf(PromotionNotFoundError);
  });
});

describe('updatePromotion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFindFirst.mockResolvedValue(promotionRow());
    mockedMenuItems.mockResolvedValue([
      { id: '11111111-1111-1111-1111-111111111111' },
      { id: '22222222-2222-2222-2222-222222222222' },
    ]);
    tx.promotion.findUniqueOrThrow.mockResolvedValue(promotionRow({ status: 'active' }));
  });

  it('activa una promo existente conservando sus links', async () => {
    const dto = await updatePromotion({
      businessId: 'biz-1',
      id: 'promo-1',
      status: 'active',
    });

    expect(dto.status).toBe('active');
    // Sin cambios de offer/links no se reescribe la tabla puente
    expect(tx.promotion_product.deleteMany).not.toHaveBeenCalled();
  });

  it('reemplaza los links cuando se envían', async () => {
    await updatePromotion({
      businessId: 'biz-1',
      id: 'promo-1',
      productLinks,
    });

    expect(tx.promotion_product.deleteMany).toHaveBeenCalledWith({
      where: { promotion_id: 'promo-1' },
    });
    expect(tx.promotion_product.createMany).toHaveBeenCalled();
  });
});

describe('archivePromotion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('archiva en lugar de borrar', async () => {
    mockedFindFirst.mockResolvedValueOnce({ id: 'promo-1', status: 'active' });

    await archivePromotion({ businessId: 'biz-1', id: 'promo-1' });

    expect(prisma.promotion.update).toHaveBeenCalledWith({
      where: { id: 'promo-1' },
      data: { status: 'archived' },
    });
  });

  it('404 si no existe para ese negocio', async () => {
    mockedFindFirst.mockResolvedValueOnce(null);
    await expect(
      archivePromotion({ businessId: 'biz-1', id: 'promo-x' })
    ).rejects.toBeInstanceOf(PromotionNotFoundError);
  });
});
