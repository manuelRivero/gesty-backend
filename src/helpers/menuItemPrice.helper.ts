import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { refreshMenuItemEmbedding } from "../services/ai/menuItemEmbedding.service";

export type MenuItemPriceInput = {
  amount: number | Prisma.Decimal;
  currencyCode?: string;
};

export type MenuItemPriceDto = {
  id: string;
  currencyCode: string;
  amount: string;
};

export function buildActivePriceWhere(
  currency: string | null,
  now: Date = new Date()
): Prisma.menu_item_priceWhereInput {
  const base: Prisma.menu_item_priceWhereInput = {
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
}

export function toMenuItemPriceDto(price: {
  id: string;
  currency_code: string;
  amount: Prisma.Decimal;
}): MenuItemPriceDto {
  return {
    id: price.id,
    currencyCode: price.currency_code,
    amount: price.amount.toFixed(2)
  };
}

export function activePriceSelect(
  currency: string | null,
  now: Date = new Date()
) {
  return {
    where: buildActivePriceWhere(currency, now),
    orderBy: { valid_from: "desc" as const },
    take: 1,
    select: {
      id: true,
      currency_code: true,
      amount: true
    }
  };
}

export async function getBusinessCurrencyCode(
  businessId: string
): Promise<string | null> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { currency_code: true }
  });
  return business?.currency_code ?? null;
}

export type UpsertMenuItemPriceResult = {
  price: { id: string; menu_item_id: string; currency_code: string; amount: Prisma.Decimal };
  /** `true` si el precio activo se creó o si el monto difiere del anterior. */
  changed: boolean;
};

export async function upsertMenuItemPrice(params: {
  menuItemId: string;
  businessId: string;
  price: MenuItemPriceInput;
}): Promise<UpsertMenuItemPriceResult> {
  const businessCurrency = await getBusinessCurrencyCode(params.businessId);
  const currencyCode = params.price.currencyCode ?? businessCurrency;

  if (!currencyCode) {
    throw new Error("BUSINESS_CURRENCY_NOT_SET");
  }

  const amount =
    params.price.amount instanceof Prisma.Decimal
      ? params.price.amount
      : new Prisma.Decimal(params.price.amount);

  const now = new Date();
  const priceWhere = buildActivePriceWhere(currencyCode, now);

  const existing = await prisma.menu_item_price.findFirst({
    where: {
      menu_item_id: params.menuItemId,
      ...priceWhere
    },
    orderBy: { valid_from: "desc" }
  });

  if (existing) {
    const changed = !existing.amount.equals(amount);
    const price = changed
      ? await prisma.menu_item_price.update({
          where: { id: existing.id },
          data: { amount }
        })
      : existing;

    if (changed) {
      await refreshMenuItemEmbedding(params.menuItemId);
    }

    return { price, changed };
  }

  const price = await prisma.menu_item_price.create({
    data: {
      menu_item_id: params.menuItemId,
      currency_code: currencyCode,
      amount
    }
  });

  await refreshMenuItemEmbedding(params.menuItemId);

  return { price, changed: true };
}
