import { MenuCategoryTag, type Prisma } from "@prisma/client";
import {
  activePriceSelect,
  getBusinessCurrencyCode,
  toMenuItemPriceDto,
  upsertMenuItemPrice,
  type MenuItemPriceInput
} from "../helpers/menuItemPrice.helper";
import { prisma } from "../lib/prisma";

export type ListAdminMenuItemsParams = {
  businessId: string;
  page: number;
  pageSize: number;
  categoryId?: string;
  q?: string;
  includeUnavailable?: boolean;
  all?: boolean;
};

export async function listAdminMenuItems(params: ListAdminMenuItemsParams) {
  const where: Prisma.menu_itemWhereInput = {
    business_id: params.businessId
  };

  if (!params.includeUnavailable) {
    where.is_available = true;
  }

  if (params.categoryId) {
    where.category_id = params.categoryId;
  }

  if (params.q?.trim()) {
    const query = params.q.trim();
    where.OR = [
      { name: { contains: query, mode: "insensitive" } },
      { description: { contains: query, mode: "insensitive" } },
      { ingredients: { contains: query, mode: "insensitive" } }
    ];
  }

  const currencyCode = await getBusinessCurrencyCode(params.businessId);

  const [total, rows] = await prisma.$transaction([
    prisma.menu_item.count({ where }),
    prisma.menu_item.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: params.all ? undefined : (params.page - 1) * params.pageSize,
      take: params.all ? undefined : params.pageSize,
      include: {
        menu_category: {
          select: {
            id: true,
            name: true,
            category_tag: true
          }
        },
        menu_item_price: activePriceSelect(currencyCode)
      }
    })
  ]);

  const effectivePageSize = params.all ? total : params.pageSize;
  const effectivePage = params.all ? 1 : params.page;
  const effectiveTotalPages = params.all
    ? total === 0
      ? 0
      : 1
    : total === 0
      ? 0
      : Math.ceil(total / params.pageSize);

  return {
    items: rows.map((row) => formatAdminMenuItem(row)),
    total,
    page: effectivePage,
    pageSize: effectivePageSize,
    totalPages: effectiveTotalPages
  };
}

export async function listAdminMenuCategoriesOptions(params: {
  businessId: string;
}) {
  const rows = await prisma.menu_category.findMany({
    where: {
      business_id: params.businessId
    },
    orderBy: [{ position: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true
    }
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name
  }));
}

const MENU_CATEGORY_TAG_LABEL: Record<MenuCategoryTag, string> = {
  STARTER: "Entradas",
  MAIN: "Platos fuertes",
  SIDE: "Guarniciones",
  DRINK: "Bebidas",
  DESSERT: "Postres",
  OTHER: "Otros"
};

export async function listAdminMenuCategoryTagsOptions(params: {
  businessId: string;
}) {
  const rows = await prisma.menu_category.findMany({
    where: {
      business_id: params.businessId
    },
    orderBy: [{ position: "asc" }, { name: "asc" }],
    select: {
      category_tag: true
    }
  });

  const uniqueTags = Array.from(new Set(rows.map((row) => row.category_tag)));

  return uniqueTags.map((tag) => ({
    id: tag,
    name: MENU_CATEGORY_TAG_LABEL[tag]
  }));
}

export async function createAdminMenuItem(params: {
  businessId: string;
  categoryId?: string;
  categoryTag?: MenuCategoryTag;
  name: string;
  description?: string | null;
  ingredients?: string | null;
  preparation?: string | null;
  servesPeople?: number | null;
  isFeatured?: boolean;
  image?: string | null;
  isAvailable?: boolean;
  price?: MenuItemPriceInput;
}) {
  const resolvedCategoryId = await resolveCategoryId(params.businessId, {
    categoryId: params.categoryId,
    categoryTag: params.categoryTag
  });
  if (!resolvedCategoryId) {
    throw new Error("CATEGORY_NOT_FOUND");
  }

  const created = await prisma.menu_item.create({
    data: {
      business_id: params.businessId,
      category_id: resolvedCategoryId,
      name: params.name,
      description: params.description ?? null,
      ingredients: params.ingredients ?? null,
      preparation: params.preparation ?? null,
      serves_people: params.servesPeople ?? null,
      is_featured: params.isFeatured ?? false,
      image: params.image ?? null,
      is_available: params.isAvailable ?? true
    }
  });

  if (params.price) {
    await upsertMenuItemPrice({
      businessId: params.businessId,
      menuItemId: created.id,
      price: params.price
    });
  }

  return getAdminMenuItemById({
    businessId: params.businessId,
    id: created.id
  });
}

export async function getAdminMenuItemById(params: {
  businessId: string;
  id: string;
}) {
  const currencyCode = await getBusinessCurrencyCode(params.businessId);

  const row = await prisma.menu_item.findFirst({
    where: {
      id: params.id,
      business_id: params.businessId
    },
    include: {
      menu_category: {
        select: {
          id: true,
          name: true,
          category_tag: true
        }
      },
      menu_item_price: activePriceSelect(currencyCode)
    }
  });

  if (!row) {
    return null;
  }

  return formatAdminMenuItem(row);
}

export async function updateAdminMenuItem(params: {
  businessId: string;
  id: string;
  categoryId?: string;
  categoryTag?: MenuCategoryTag;
  name?: string;
  description?: string | null;
  ingredients?: string | null;
  preparation?: string | null;
  servesPeople?: number | null;
  isFeatured?: boolean;
  image?: string | null;
  isAvailable?: boolean;
  price?: MenuItemPriceInput;
}) {
  const existing = await prisma.menu_item.findFirst({
    where: {
      id: params.id,
      business_id: params.businessId
    },
    select: { id: true }
  });
  if (!existing) {
    return null;
  }

  let resolvedCategoryId: string | undefined;
  if (params.categoryId !== undefined || params.categoryTag !== undefined) {
    const maybeCategoryId = await resolveCategoryId(params.businessId, {
      categoryId: params.categoryId,
      categoryTag: params.categoryTag
    });
    if (!maybeCategoryId) {
      throw new Error("CATEGORY_NOT_FOUND");
    }
    resolvedCategoryId = maybeCategoryId;
  }

  await prisma.menu_item.update({
    where: { id: params.id },
    data: {
      ...(resolvedCategoryId !== undefined ? { category_id: resolvedCategoryId } : {}),
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.ingredients !== undefined ? { ingredients: params.ingredients } : {}),
      ...(params.preparation !== undefined ? { preparation: params.preparation } : {}),
      ...(params.servesPeople !== undefined ? { serves_people: params.servesPeople } : {}),
      ...(params.isFeatured !== undefined ? { is_featured: params.isFeatured } : {}),
      ...(params.image !== undefined ? { image: params.image } : {}),
      ...(params.isAvailable !== undefined ? { is_available: params.isAvailable } : {})
    }
  });

  if (params.price) {
    await upsertMenuItemPrice({
      businessId: params.businessId,
      menuItemId: params.id,
      price: params.price
    });
  }

  return getAdminMenuItemById({
    businessId: params.businessId,
    id: params.id
  });
}

/** Eliminación segura: soft delete vía `is_available = false`. */
export async function deleteAdminMenuItem(params: {
  businessId: string;
  id: string;
}) {
  const existing = await prisma.menu_item.findFirst({
    where: {
      id: params.id,
      business_id: params.businessId
    },
    select: { id: true }
  });
  if (!existing) {
    return null;
  }

  return prisma.menu_item.update({
    where: { id: params.id },
    data: { is_available: false }
  });
}

type AdminMenuItemRow = Prisma.menu_itemGetPayload<{
  include: {
    menu_category: {
      select: {
        id: true;
        name: true;
        category_tag: true;
      };
    };
    menu_item_price: {
      select: {
        id: true;
        currency_code: true;
        amount: true;
      };
    };
  };
}>;

function formatAdminMenuItem(row: AdminMenuItemRow) {
  const activePrice = row.menu_item_price[0];

  return {
    ...row,
    menu_item_price: undefined,
    categoryName: row.menu_category?.name ?? null,
    categoryTag: row.menu_category?.category_tag ?? null,
    price: activePrice ? toMenuItemPriceDto(activePrice) : null
  };
}

async function resolveCategoryId(
  businessId: string,
  input: { categoryId?: string; categoryTag?: MenuCategoryTag }
): Promise<string | null> {
  if (input.categoryId) {
    const byId = await prisma.menu_category.findFirst({
      where: {
        id: input.categoryId,
        business_id: businessId
      },
      select: { id: true }
    });
    return byId?.id ?? null;
  }

  if (input.categoryTag) {
    const byTag = await prisma.menu_category.findFirst({
      where: {
        business_id: businessId,
        category_tag: input.categoryTag
      },
      orderBy: [{ is_active: "desc" }, { position: "asc" }, { created_at: "asc" }],
      select: { id: true }
    });
    return byTag?.id ?? null;
  }

  return null;
}
