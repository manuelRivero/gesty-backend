import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getProductEmbedding } from './ai/openai.service';

export type MenuButton = {
  title: string;
  payload: string;
  description?: string;
  sectionTitle?: string;
};

export type MenuResponse = {
  text: string;
  buttons: MenuButton[];
};

export type ItemButton = {
  title: string;
  payload: string;
};

export type ItemResponse = {
  text: string;
  buttons: ItemButton[];
};

type MenuPrice = {
  amount: Prisma.Decimal;
  currency_code: string;
};

export type MenuItemSearchResult = {
  id: string;
  name: string;
  description: string | null;
  ingredients: string | null;
  serves_people: number | null;
  is_available: boolean;
  menu_item_price: MenuPrice[];
  distance?: number;
  // Campos de categoría — opcionales, presentes cuando searchMenuItemsByKeyword hace el JOIN
  category_id?: string | null;
  category_name?: string | null;
  category_tag?: string | null;
  /** Variaciones de nombre del platillo (D1: `[]`/`null` ≡ sin variaciones). */
  variations?: string[] | null;
};

export type FeaturedMenuItemsPageResult = {
  items: MenuItemSearchResult[];
  page: number;
  totalPages: number;
  totalCount: number;
  pageSize: number;
};

const formatPrice = (price: MenuPrice): string => {
  const amount = price.amount.toFixed(2);
  return `${amount} ${price.currency_code}`;
};

const buildPriceWhere = (currency: string | null, now: Date) => {
  const base = {
    is_active: true,
    valid_from: { lte: now },
    OR: [{ valid_to: null }, { valid_to: { gte: now } }]
  };

  if (!currency) {
    return base;
  }

  return {
    ...base,
    currency_code: currency
  };
};

const toButtonTitle = (value: string): string => value.slice(0, 20);
const toRowDescription = (value: string): string => value.slice(0, 72);

export class MenuService {
  static async getMenuForCustomer(params: {
    businessId: string;
    customerId: string;
  }): Promise<MenuResponse> {
    const { businessId, customerId } = params;
    const [customer, business] = await Promise.all([
      prisma.customer.findUnique({
        where: { id: customerId },
        select: { preferred_currency: true }
      }),
      prisma.business.findUnique({
        where: { id: businessId },
        select: { name: true }
      })
    ]);

    const businessName = business?.name ?? 'nuestro local';
    const currency = customer?.preferred_currency ?? null;

    const lines: string[] = [
      `🍽️ Menú de ${businessName}`,
      '',
      `Bienvenido/a a ${businessName}! Gracias por escribirnos.`,
      'Para realizar tu pedido, toca "Ver menú" y selecciona tus platillos.'
    ];

    if (!currency) {
      lines.push('', 'ℹ️ No tengo tu moneda preferida, los precios pueden omitirse.');
    }

    const buttons: MenuButton[] = [
      {
        title: 'Ver menú',
        payload: 'VIEW_MENU'
      },
      {
        title: 'Tengo una duda',
        payload: 'ASK_QUESTION'
      }
    ];

    return {
      text: lines.join('\n'),
      buttons
    };
  }

  static async getCategoryListForCustomer(params: {
    businessId: string;
    customerId: string;
  }): Promise<MenuResponse> {
    const { businessId, customerId } = params;
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { preferred_currency: true }
    });

    const currency = customer?.preferred_currency ?? null;
    const now = new Date();
    const priceWhere = buildPriceWhere(currency, now);

    const categories = await prisma.menu_category.findMany({
      where: {
        business_id: businessId,
        is_active: true
      },
      orderBy: { position: 'asc' },
      include: {
        menu_item: {
          where: {
            is_available: true,
            menu_item_price: {
              some: priceWhere
            }
          },
          select: { id: true }
        }
      }
    });

    const visibleCategories = categories.filter(
      (category) => category.menu_item.length > 0
    );

    const lines: string[] = ['📋 Categorías disponibles', '', 'Selecciona una categoría.'];

    if (visibleCategories.length === 0) {
      return {
        text: 'No hay categorías disponibles en este momento.',
        buttons: []
      };
    }

    const buttons: MenuButton[] = visibleCategories.map((category) => ({
      title: toButtonTitle(category.name),
      payload: `CATEGORY:${category.id}`,
      description: toRowDescription(category.description ?? 'Opciones disponibles'),
      sectionTitle: 'Categorías'
    }));

    return {
      text: lines.join('\n'),
      buttons
    };
  }

  static async getItemsByCategory(params: {
    businessId: string;
    customerId: string;
    categoryId: string;
  }): Promise<ItemResponse> {
    const { businessId, customerId, categoryId } = params;

    const [business, customer] = await Promise.all([
      prisma.business.findUnique({ where: { id: businessId }, select: { id: true } }),
      prisma.customer.findUnique({
        where: { id: customerId },
        select: { preferred_currency: true }
      })
    ]);

    if (!business) {
      throw new Error('Business no encontrado');
    }
    if (!customer) {
      throw new Error('Customer no encontrado');
    }

    const currency = customer.preferred_currency ?? null;
    if (!currency) {
      return {
        text: 'No tengo tu moneda preferida registrada. Por favor indícala para mostrar precios.',
        buttons: [{ title: 'Volver a categorías', payload: 'VIEW_MENU' }]
      };
    }

    const now = new Date();
    const priceWhere = buildPriceWhere(currency, now);

    const items = await prisma.menu_item.findMany({
      where: {
        business_id: businessId,
        category_id: categoryId,
        is_available: true,
        menu_item_price: {
          some: priceWhere
        }
      },
      orderBy: { created_at: 'asc' },
      include: {
        menu_item_price: {
          where: priceWhere,
          orderBy: { valid_from: 'desc' },
          take: 1
        }
      }
    });

    if (items.length === 0) {
      return {
        text: 'No hay productos disponibles en esta categoría.',
        buttons: [{ title: 'Volver a categorías', payload: 'VIEW_MENU' }]
      };
    }

    const lines: string[] = ['📝 Productos:'];
    items.forEach((item, idx) => {
      const price = item.menu_item_price[0];
      const priceText = price ? formatPrice(price) : 'N/A';
      lines.push(`${idx + 1}) ${item.name} - ${priceText}`);
    });

    const buttons: ItemButton[] = items.slice(0, 3).map((item) => ({
      title: toButtonTitle(`Agregar: ${item.name}`),
      payload: `ADD_ITEM:${item.id}:1`
    }));

    buttons.push({ title: 'Volver a categorías', payload: 'VIEW_MENU' });

    return {
      text: lines.join('\n'),
      buttons
    };
  }

  static async searchMenuItemsByKeyword(params: {
    businessId: string;
    keyword: string;
  }): Promise<MenuItemSearchResult[]> {
  
    const { businessId, keyword } = params;
  
    if (!keyword.trim()) return [];
  
  
    const queryEmbedding = await getProductEmbedding(keyword)
    const queryEmbeddingString = `[${queryEmbedding.join(",")}]`;

    // 2️⃣ Buscar por similitud coseno (incluye categoría para que el agente use la taxonomía real)
    const results = await prisma.$queryRaw<MenuItemSearchResult[]>`
  SELECT 
    m.id,
    m.name,
    m.description,
    m.ingredients,
    m.serves_people,
    m.is_available,
    m.image,
    m.variations,
    (m.embedding <=> ${queryEmbeddingString}::vector) AS distance,
    mc.id   AS category_id,
    mc.name AS category_name,
    mc.category_tag AS category_tag
  FROM menu_item m
  LEFT JOIN menu_category mc ON mc.id = m.category_id
  WHERE m.business_id = ${businessId}
    AND m.is_available = true
    AND m.embedding IS NOT NULL
  ORDER BY m.embedding <=> ${queryEmbeddingString}::vector
  LIMIT 10;
`;
    console.log(
      results.map(r => ({
        name: r.name,
        distance: r.distance
      }))
    );
  
    // 3️⃣ Filtrar por umbral de similitud
    const SIMILARITY_THRESHOLD = 0.5;

    const filtered = results.filter(
      (r) => r.distance !== undefined && r.distance < SIMILARITY_THRESHOLD
    );
    
    let finalResults;
    
    if (filtered.length > 0) {
      finalResults = filtered;
    } else {
      // Fallback inteligente
      finalResults = results.slice(0, 3);
    }
    return finalResults;
  }
  static async searchMenuItemsForOrder(params: {
    businessId: string;
    keyword: string;
  }): Promise<MenuItemSearchResult[]> {
  
    const { businessId, keyword } = params;
    const trimmedKeyword = keyword.trim();
    if (!trimmedKeyword) return [];
  
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { currency_code: true }
    });
  
    const currency = business?.currency_code ?? null;
    const now = new Date();
    const priceWhere = buildPriceWhere(currency, now);
  
    return prisma.menu_item.findMany({
      where: {
        business_id: businessId,
        is_available: true,
        OR: [
          {
            name: {
              equals: trimmedKeyword,
              mode: 'insensitive'
            }
          },
          {
            name: {
              contains: trimmedKeyword,
              mode: 'insensitive'
            }
          }
        ]
      },
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        ingredients: true,
        serves_people: true,
        is_available: true,
        variations: true,
        menu_item_price: {
          where: priceWhere,
          orderBy: { valid_from: 'desc' },
          take: 1,
          select: {
            amount: true,
            currency_code: true
          }
        }
      }
    });
  }

  static async getFeaturedMenuItems(params: {
    businessId: string;
    currencyCode?: string | null;
    limit?: number;
  }): Promise<MenuItemSearchResult[]> {
    const { businessId, currencyCode = null, limit = 8 } = params;
    const now = new Date();
    const priceWhere = buildPriceWhere(currencyCode, now);
    return prisma.menu_item.findMany({
      where: {
        business_id: businessId,
        is_available: true,
        is_featured: true,
        menu_item_price: {
          some: priceWhere
        }
      },
      orderBy: [{ created_at: 'desc' }],
      take: Math.max(1, Math.min(limit, 20)),
      select: {
        id: true,
        name: true,
        description: true,
        ingredients: true,
        serves_people: true,
        is_available: true,
        variations: true,
        menu_item_price: {
          where: priceWhere,
          orderBy: { valid_from: 'desc' },
          take: 1,
          select: {
            amount: true,
            currency_code: true
          }
        }
      }
    });
  }

  static async getFeaturedMenuItemsPage(params: {
    businessId: string;
    currencyCode?: string | null;
    page?: number;
    pageSize?: number;
  }): Promise<FeaturedMenuItemsPageResult> {
    const {
      businessId,
      currencyCode = null,
      page = 1,
      pageSize = 8,
    } = params;
    const now = new Date();
    const priceWhere = buildPriceWhere(currencyCode, now);
    const safePageSize = Math.max(1, Math.min(pageSize, 20));

    const where = {
      business_id: businessId,
      is_available: true,
      is_featured: true,
      menu_item_price: {
        some: priceWhere
      }
    } as const;

    const totalCount = await prisma.menu_item.count({ where });
    const totalPages = Math.max(1, Math.ceil(totalCount / safePageSize));
    const safePage = Math.min(Math.max(page, 1), totalPages);
    const skip = (safePage - 1) * safePageSize;

    const items = await prisma.menu_item.findMany({
      where,
      orderBy: [{ created_at: 'desc' }],
      skip,
      take: safePageSize,
      select: {
        id: true,
        name: true,
        description: true,
        ingredients: true,
        serves_people: true,
        is_available: true,
        variations: true,
        menu_item_price: {
          where: priceWhere,
          orderBy: { valid_from: 'desc' },
          take: 1,
          select: {
            amount: true,
            currency_code: true
          }
        }
      }
    });

    return {
      items,
      page: safePage,
      totalPages,
      totalCount,
      pageSize: safePageSize,
    };
  }
}
