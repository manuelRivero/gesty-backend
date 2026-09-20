import {
  FulfillmentType,
  OrderPaymentStatus,
  OrderStatus,
  Prisma
} from "@prisma/client";
import {
  activePriceSelect,
  resolveEffectivePrice
} from "../helpers/menuItemPrice.helper";
import { prisma } from "../lib/prisma";
import { findOrCreateCustomer } from "../repositories/customer.repository";
import { findCoverageZoneForPoint } from "../repositories/coverageZone.repository";
import type { CoverageZoneRow } from "../repositories/coverageZone.repository";
import { emitAdminOrderCreated } from "../socket/adminSocket";
import { getBusinessConfig, hasDeliveryCapability } from "./businessConfig.service";
import { getBusinessOpenInfo } from "./businessHours.service";
import {
  hasVariations,
  matchVariation
} from "./menu/menuItemVariations";
import { normalizePhoneDigits } from "./ownerAssistant/matchOwnerPhone";
import { computeOrderPricing } from "./pricing.service";
import { resolveActivePublicBusiness } from "./publicStorefront.service";

/** Cobro manual en mostrador / al recibir — nunca online/MP. */
export const COUNTER_PAYMENT_METHOD = "cash" as const;

export type PublicOrderLineInput = {
  menuItemId: string;
  quantity: number;
  variation?: string | null;
  notes?: string | null;
};

export type PublicDeliveryAddressInput = {
  latitude: number;
  longitude: number;
  streetAddress: string;
  apartment?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  instructions?: string | null;
};

export type CreatePublicCounterOrderInput = {
  slugOrId: string;
  customer: {
    name?: string | null;
    phone: string;
  };
  items: PublicOrderLineInput[];
  fulfillmentType?: "TAKE_AWAY" | "DELIVERY";
  /** Obligatorio si fulfillmentType = DELIVERY (lat/lng = destino del pin). */
  address?: PublicDeliveryAddressInput | null;
  notes?: string | null;
};

export type PublicOrderLineResult = {
  menuItemId: string;
  name: string;
  quantity: number;
  variation: string | null;
  notes: string | null;
  unitPrice: string;
  lineTotal: string;
};

export type PublicOrderAddressView = {
  streetAddress: string;
  apartment: string | null;
  neighborhood: string | null;
  city: string | null;
  instructions: string | null;
};

/** Misma forma para POST 201 y GET de seguimiento (poll). */
export type PublicOrderView = {
  orderId: string;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  paymentMethod: string;
  fulfillmentType: FulfillmentType;
  currencyCode: string;
  total: string;
  deliveryFee: string | null;
  address: PublicOrderAddressView | null;
  customer: {
    id: string;
    name: string | null;
    phone: string;
  };
  items: PublicOrderLineResult[];
  createdAt: string;
};

/** @deprecated Prefer PublicOrderView — alias del create. */
export type CreatePublicCounterOrderResult = PublicOrderView;

export type PublicDeliveryQuoteResult = {
  inCoverage: boolean;
  deliveryFee: string | null;
  minOrderAmount: string | null;
  minOrderMet: boolean | null;
  estimatedMinutes: number | null;
  zoneId: string | null;
  zoneName: string | null;
};

export class PublicOrderError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(
    code: string,
    httpStatus: number,
    message: string,
    details?: unknown
  ) {
    super(message);
    this.name = "PublicOrderError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

function assertPhone(raw: string): string {
  const digits = normalizePhoneDigits(raw);
  if (digits.length < 8 || digits.length > 15) {
    throw new PublicOrderError(
      "INVALID_PHONE",
      400,
      "Teléfono inválido: usá código de país + número (solo dígitos)"
    );
  }
  return digits;
}

function assertCoordinates(latitude: number, longitude: number): void {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new PublicOrderError(
      "INVALID_COORDINATES",
      400,
      "Coordenadas inválidas"
    );
  }
}

function zoneFee(zone: CoverageZoneRow): number {
  return zone.delivery_fee ? Number(zone.delivery_fee) : 0;
}

function zoneMinOrder(zone: CoverageZoneRow): number {
  return zone.min_order_amount ? Number(zone.min_order_amount) : 0;
}

function money(n: number): string {
  return n.toFixed(2);
}

function addressViewFromInput(
  address: PublicDeliveryAddressInput
): PublicOrderAddressView {
  return {
    streetAddress: address.streetAddress.trim(),
    apartment: address.apartment?.trim() || null,
    neighborhood: address.neighborhood?.trim() || null,
    city: address.city?.trim() || null,
    instructions: address.instructions?.trim() || null
  };
}

function addressViewFromSnapshot(
  snapshot: unknown
): PublicOrderAddressView | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }
  const s = snapshot as Record<string, unknown>;
  const street =
    typeof s.street_address === "string"
      ? s.street_address
      : typeof s.streetAddress === "string"
        ? s.streetAddress
        : null;
  if (!street) return null;
  return {
    streetAddress: street,
    apartment:
      typeof s.apartment === "string" && s.apartment.trim()
        ? s.apartment
        : null,
    neighborhood:
      typeof s.neighborhood === "string" && s.neighborhood.trim()
        ? s.neighborhood
        : null,
    city: typeof s.city === "string" && s.city.trim() ? s.city : null,
    instructions:
      typeof s.delivery_instructions === "string" &&
      s.delivery_instructions.trim()
        ? s.delivery_instructions
        : typeof s.instructions === "string" && s.instructions.trim()
          ? s.instructions
          : null
  };
}

type ResolvedLine = {
  menuItemId: string;
  name: string;
  quantity: number;
  variation: string | null;
  notes: string | null;
  unitPrice: Prisma.Decimal;
  listPrice: Prisma.Decimal | null;
  discountAmount: Prisma.Decimal | null;
  servesPeople: number | null;
};

async function resolveLines(params: {
  businessId: string;
  currencyCode: string;
  items: PublicOrderLineInput[];
}): Promise<ResolvedLine[]> {
  const ids = [...new Set(params.items.map((i) => i.menuItemId))];
  const rows = await prisma.menu_item.findMany({
    where: {
      id: { in: ids },
      business_id: params.businessId
    },
    select: {
      id: true,
      name: true,
      is_available: true,
      serves_people: true,
      variations: true,
      discount_type: true,
      discount_value: true,
      menu_item_price: activePriceSelect(params.currencyCode)
    }
  });

  const byId = new Map(rows.map((r) => [r.id, r]));
  const resolved: ResolvedLine[] = [];

  for (const line of params.items) {
    const item = byId.get(line.menuItemId);
    if (!item) {
      throw new PublicOrderError(
        "ITEM_NOT_FOUND",
        400,
        "Hay productos que no pertenecen a este local",
        { menuItemId: line.menuItemId }
      );
    }
    if (!item.is_available) {
      throw new PublicOrderError(
        "ITEM_UNAVAILABLE",
        400,
        `"${item.name}" no está disponible`,
        { menuItemId: item.id }
      );
    }
    if (!item.menu_item_price[0]) {
      throw new PublicOrderError(
        "PRICE_UNAVAILABLE",
        400,
        `"${item.name}" no tiene precio activo`,
        { menuItemId: item.id }
      );
    }

    let variation: string | null = null;
    if (hasVariations(item)) {
      const raw = line.variation?.trim() ?? "";
      if (!raw) {
        throw new PublicOrderError(
          "VARIATION_REQUIRED",
          400,
          `"${item.name}" requiere una variación`,
          { menuItemId: item.id, variations: item.variations }
        );
      }
      const match = matchVariation(raw, item.variations);
      if (match.status === "ok") {
        variation = match.value;
      } else if (match.status === "ambiguous") {
        throw new PublicOrderError(
          "VARIATION_AMBIGUOUS",
          400,
          `Variación ambigua para "${item.name}"`,
          { menuItemId: item.id, candidates: match.candidates }
        );
      } else {
        throw new PublicOrderError(
          "VARIATION_INVALID",
          400,
          `Variación inválida para "${item.name}"`,
          { menuItemId: item.id, variations: item.variations }
        );
      }
    } else if (line.variation?.trim()) {
      throw new PublicOrderError(
        "VARIATION_NOT_ALLOWED",
        400,
        `"${item.name}" no admite variaciones`,
        { menuItemId: item.id }
      );
    }

    const price = resolveEffectivePrice(item);
    resolved.push({
      menuItemId: item.id,
      name: item.name,
      quantity: line.quantity,
      variation,
      notes: line.notes?.trim() ? line.notes.trim().slice(0, 500) : null,
      unitPrice: price.finalPrice,
      listPrice: price.hasDiscount ? price.listPrice : null,
      discountAmount: price.hasDiscount ? price.discountAmount : null,
      servesPeople: item.serves_people ?? null
    });
  }

  return resolved;
}

/**
 * Cotiza cobertura/fee para un pin (lat/lng destino). Sin geocode.
 * Fuera de zona → 200 + inCoverage:false (no error de red para el front).
 */
export async function quotePublicDelivery(params: {
  slugOrId: string;
  latitude: number;
  longitude: number;
  /** Hint de UI; el POST revalida con precios de servidor. */
  itemsSubtotal?: number | null;
}): Promise<PublicDeliveryQuoteResult> {
  const business = await resolveActivePublicBusiness(params.slugOrId);
  if (!business) {
    throw new PublicOrderError(
      "LOCAL_UNAVAILABLE",
      404,
      "local no disponible"
    );
  }

  const config = await getBusinessConfig(business.id);
  if (!hasDeliveryCapability(config)) {
    throw new PublicOrderError(
      "DELIVERY_DISABLED",
      403,
      "Este local no tiene envío habilitado"
    );
  }

  assertCoordinates(params.latitude, params.longitude);

  const zone = await findCoverageZoneForPoint(
    params.latitude,
    params.longitude,
    business.id
  );

  if (!zone) {
    return {
      inCoverage: false,
      deliveryFee: null,
      minOrderAmount: null,
      minOrderMet: null,
      estimatedMinutes: null,
      zoneId: null,
      zoneName: null
    };
  }

  const deliveryFee = zoneFee(zone);
  const minOrderAmount = zoneMinOrder(zone);
  const subtotal =
    params.itemsSubtotal != null && Number.isFinite(params.itemsSubtotal)
      ? params.itemsSubtotal
      : null;

  return {
    inCoverage: true,
    deliveryFee: money(deliveryFee),
    minOrderAmount: money(minOrderAmount),
    minOrderMet:
      subtotal == null
        ? null
        : minOrderAmount <= 0
          ? true
          : subtotal >= minOrderAmount,
    estimatedMinutes: zone.estimated_delivery_minutes ?? null,
    zoneId: zone.id,
    zoneName: zone.name ?? null
  };
}

/**
 * Persiste dirección default del cliente con geography + zona (mismo espíritu que el bot).
 */
async function upsertCustomerDeliveryAddress(params: {
  customerId: string;
  address: PublicDeliveryAddressInput;
  zoneId: string;
}): Promise<string> {
  const street = params.address.streetAddress.trim().slice(0, 255);
  if (!street) {
    throw new PublicOrderError(
      "INVALID_ADDRESS",
      400,
      "La dirección necesita calle / referencia"
    );
  }

  await prisma.customer_address.updateMany({
    where: { customer_id: params.customerId },
    data: { is_default: false }
  });

  const created = await prisma.customer_address.create({
    data: {
      customer_id: params.customerId,
      street_address: street,
      apartment: params.address.apartment?.trim()?.slice(0, 50) || null,
      neighborhood:
        params.address.neighborhood?.trim()?.slice(0, 100) || null,
      city: params.address.city?.trim()?.slice(0, 100) || null,
      delivery_instructions:
        params.address.instructions?.trim()?.slice(0, 500) || null,
      is_default: true,
      delivery_zone_id: params.zoneId
    },
    select: { id: true }
  });

  await prisma.$executeRaw`
    UPDATE customer_address
    SET location = ST_SetSRID(ST_MakePoint(${params.address.longitude}::float8, ${params.address.latitude}::float8), 4326)::geography
    WHERE id = ${created.id}::uuid
  `;

  return created.id;
}

function buildDeliverySnapshot(address: PublicDeliveryAddressInput) {
  return {
    street_address: address.streetAddress.trim(),
    apartment: address.apartment?.trim() || null,
    neighborhood: address.neighborhood?.trim() || null,
    city: address.city?.trim() || null,
    postal_code: null,
    country: "AR",
    delivery_instructions: address.instructions?.trim() || null,
    latitude: address.latitude,
    longitude: address.longitude
  };
}

/**
 * Crea un pedido de autoservicio / mostrador o delivery web.
 * Aislado de WhatsApp draft, conversation y Mercado Pago:
 * `payment_method=cash`, `payment_status=unpaid`, `status=placed`.
 */
export async function createPublicCounterOrder(
  input: CreatePublicCounterOrderInput
): Promise<PublicOrderView> {
  const business = await resolveActivePublicBusiness(input.slugOrId);
  if (!business) {
    throw new PublicOrderError(
      "LOCAL_UNAVAILABLE",
      404,
      "local no disponible"
    );
  }

  if (!business.currency_code) {
    throw new PublicOrderError(
      "CURRENCY_NOT_SET",
      503,
      "El local no tiene moneda configurada"
    );
  }

  const config = await getBusinessConfig(business.id);
  if (!config.orders_enabled) {
    throw new PublicOrderError(
      "ORDERS_DISABLED",
      403,
      "Este local no toma pedidos por este canal"
    );
  }

  const fulfillmentType =
    input.fulfillmentType === "DELIVERY"
      ? FulfillmentType.DELIVERY
      : FulfillmentType.TAKE_AWAY;

  if (fulfillmentType === FulfillmentType.TAKE_AWAY) {
    if (!config.takeaway_enabled) {
      throw new PublicOrderError(
        "TAKEAWAY_DISABLED",
        403,
        "Este local no tiene retiro en mostrador habilitado"
      );
    }
  } else {
    if (!hasDeliveryCapability(config)) {
      throw new PublicOrderError(
        "DELIVERY_DISABLED",
        403,
        "Este local no tiene envío habilitado"
      );
    }
    if (!input.address) {
      throw new PublicOrderError(
        "ADDRESS_REQUIRED",
        400,
        "Delivery requiere dirección con coordenadas"
      );
    }
  }

  const open = await getBusinessOpenInfo({
    businessId: business.id,
    timezone: business.timezone
  });
  if (!open.isOpen && !config.orders_when_closed) {
    throw new PublicOrderError(
      "CLOSED",
      403,
      open.nextOpenText
        ? `El local está cerrado. Abrimos ${open.nextOpenText}`
        : "El local está cerrado"
    );
  }

  const phone = assertPhone(input.customer.phone);
  const customerName = input.customer.name?.trim()
    ? input.customer.name.trim().slice(0, 120)
    : undefined;

  const lines = await resolveLines({
    businessId: business.id,
    currencyCode: business.currency_code,
    items: input.items
  });

  let deliveryFee = 0;
  let customerAddressId: string | undefined;
  let deliveryAddressSnapshot: object = {};
  let addressView: PublicOrderAddressView | null = null;

  if (fulfillmentType === FulfillmentType.DELIVERY && input.address) {
    assertCoordinates(input.address.latitude, input.address.longitude);

    const zone = await findCoverageZoneForPoint(
      input.address.latitude,
      input.address.longitude,
      business.id
    );
    if (!zone) {
      throw new PublicOrderError(
        "OUT_OF_COVERAGE",
        400,
        "Esa ubicación está fuera de la zona de entrega"
      );
    }

    const itemsPricing = computeOrderPricing(
      lines.map((l) => ({
        quantity: l.quantity,
        unit_price: l.unitPrice,
        list_price: l.listPrice,
        discount_amount: l.discountAmount
      }))
    );
    const minOrderAmount = zoneMinOrder(zone);
    if (minOrderAmount > 0 && itemsPricing.itemsTotal < minOrderAmount) {
      throw new PublicOrderError(
        "MIN_ORDER_NOT_MET",
        400,
        "El pedido no alcanza el mínimo de la zona",
        {
          minOrderAmount: money(minOrderAmount),
          itemsSubtotal: money(itemsPricing.itemsTotal),
          missing: money(minOrderAmount - itemsPricing.itemsTotal)
        }
      );
    }

    deliveryFee = zoneFee(zone);

    const customer = await findOrCreateCustomer(
      business.id,
      phone,
      customerName
    );
    customerAddressId = await upsertCustomerDeliveryAddress({
      customerId: customer.id,
      address: input.address,
      zoneId: zone.id
    });
    deliveryAddressSnapshot = buildDeliverySnapshot(input.address);
    addressView = addressViewFromInput(input.address);

    const orderNote = input.notes?.trim()
      ? input.notes.trim().slice(0, 500)
      : null;
    if (orderNote && lines[0]) {
      lines[0] = {
        ...lines[0],
        notes: lines[0].notes
          ? `${lines[0].notes} | Pedido: ${orderNote}`
          : `Pedido: ${orderNote}`
      };
    }

    const pricing = computeOrderPricing(
      lines.map((l) => ({
        quantity: l.quantity,
        unit_price: l.unitPrice,
        list_price: l.listPrice,
        discount_amount: l.discountAmount
      })),
      { deliveryFee }
    );

    const order = await prisma.orders.create({
      data: {
        business_id: business.id,
        customer_id: customer.id,
        conversation_id: null,
        status: OrderStatus.placed,
        payment_status: OrderPaymentStatus.unpaid,
        payment_method: COUNTER_PAYMENT_METHOD,
        currency_code: business.currency_code,
        total_amount: pricing.total,
        delivery_fee: deliveryFee > 0 ? deliveryFee : null,
        fulfillment_type: fulfillmentType,
        customer_address_id: customerAddressId,
        delivery_address_snapshot: deliveryAddressSnapshot,
        order_item: {
          create: lines.map((l) => ({
            menu_item_id: l.menuItemId,
            quantity: l.quantity,
            unit_price: l.unitPrice,
            list_price: l.listPrice ?? undefined,
            discount_amount: l.discountAmount ?? undefined,
            notes: l.notes ?? undefined,
            variation: l.variation ?? undefined,
            serves_people: l.servesPeople ?? undefined
          }))
        }
      },
      select: {
        id: true,
        status: true,
        payment_status: true,
        payment_method: true,
        fulfillment_type: true,
        currency_code: true,
        total_amount: true,
        delivery_fee: true,
        created_at: true
      }
    });

    emitAdminOrderCreated(business.id, {
      orderId: order.id,
      total: String(pricing.total),
      currency: business.currency_code
    });

    return {
      orderId: order.id,
      status: order.status,
      paymentStatus: order.payment_status,
      paymentMethod: COUNTER_PAYMENT_METHOD,
      fulfillmentType,
      currencyCode: order.currency_code,
      total: Number(pricing.total).toFixed(2),
      deliveryFee: money(deliveryFee),
      address: addressView,
      customer: {
        id: customer.id,
        name: customer.name ?? null,
        phone: customer.phone_number
      },
      items: lines.map((l) => ({
        menuItemId: l.menuItemId,
        name: l.name,
        quantity: l.quantity,
        variation: l.variation,
        notes: l.notes,
        unitPrice: l.unitPrice.toFixed(2),
        lineTotal: l.unitPrice.mul(l.quantity).toFixed(2)
      })),
      createdAt: order.created_at.toISOString()
    };
  }

  // TAKE_AWAY
  const pricing = computeOrderPricing(
    lines.map((l) => ({
      quantity: l.quantity,
      unit_price: l.unitPrice,
      list_price: l.listPrice,
      discount_amount: l.discountAmount
    }))
  );

  const customer = await findOrCreateCustomer(
    business.id,
    phone,
    customerName
  );

  const orderNote = input.notes?.trim()
    ? input.notes.trim().slice(0, 500)
    : null;
  if (orderNote && lines[0]) {
    lines[0] = {
      ...lines[0],
      notes: lines[0].notes
        ? `${lines[0].notes} | Pedido: ${orderNote}`
        : `Pedido: ${orderNote}`
    };
  }

  const order = await prisma.orders.create({
    data: {
      business_id: business.id,
      customer_id: customer.id,
      conversation_id: null,
      status: OrderStatus.placed,
      payment_status: OrderPaymentStatus.unpaid,
      payment_method: COUNTER_PAYMENT_METHOD,
      currency_code: business.currency_code,
      total_amount: pricing.total,
      fulfillment_type: fulfillmentType,
      delivery_address_snapshot: {},
      order_item: {
        create: lines.map((l) => ({
          menu_item_id: l.menuItemId,
          quantity: l.quantity,
          unit_price: l.unitPrice,
          list_price: l.listPrice ?? undefined,
          discount_amount: l.discountAmount ?? undefined,
          notes: l.notes ?? undefined,
          variation: l.variation ?? undefined,
          serves_people: l.servesPeople ?? undefined
        }))
      }
    },
    select: {
      id: true,
      status: true,
      payment_status: true,
      payment_method: true,
      fulfillment_type: true,
      currency_code: true,
      total_amount: true,
      delivery_fee: true,
      created_at: true
    }
  });

  emitAdminOrderCreated(business.id, {
    orderId: order.id,
    total: String(pricing.total),
    currency: business.currency_code
  });

  return {
    orderId: order.id,
    status: order.status,
    paymentStatus: order.payment_status,
    paymentMethod: COUNTER_PAYMENT_METHOD,
    fulfillmentType,
    currencyCode: order.currency_code,
    total: Number(pricing.total).toFixed(2),
    deliveryFee: null,
    address: null,
    customer: {
      id: customer.id,
      name: customer.name ?? null,
      phone: customer.phone_number
    },
    items: lines.map((l) => ({
      menuItemId: l.menuItemId,
      name: l.name,
      quantity: l.quantity,
      variation: l.variation,
      notes: l.notes,
      unitPrice: l.unitPrice.toFixed(2),
      lineTotal: l.unitPrice.mul(l.quantity).toFixed(2)
    })),
    createdAt: order.created_at.toISOString()
  };
}

/**
 * Seguimiento post-checkout (Fase E).
 * Sin JWT: el orderId (UUID) es el secreto. 404 si no existe o no es del slug.
 */
export async function getPublicCounterOrder(params: {
  slugOrId: string;
  orderId: string;
}): Promise<PublicOrderView> {
  const business = await resolveActivePublicBusiness(params.slugOrId);
  if (!business) {
    throw new PublicOrderError(
      "LOCAL_UNAVAILABLE",
      404,
      "local no disponible"
    );
  }

  const order = await prisma.orders.findFirst({
    where: {
      id: params.orderId,
      business_id: business.id
    },
    select: {
      id: true,
      status: true,
      payment_status: true,
      payment_method: true,
      fulfillment_type: true,
      currency_code: true,
      total_amount: true,
      delivery_fee: true,
      delivery_address_snapshot: true,
      created_at: true,
      customer: {
        select: {
          id: true,
          name: true,
          phone_number: true
        }
      },
      order_item: {
        orderBy: { created_at: "asc" },
        select: {
          menu_item_id: true,
          quantity: true,
          unit_price: true,
          notes: true,
          variation: true,
          menu_item: {
            select: { name: true }
          }
        }
      }
    }
  });

  if (!order) {
    throw new PublicOrderError("ORDER_NOT_FOUND", 404, "Pedido no encontrado");
  }

  const fulfillmentType =
    order.fulfillment_type ?? FulfillmentType.TAKE_AWAY;
  const fee =
    order.delivery_fee != null ? Number(order.delivery_fee) : null;

  return {
    orderId: order.id,
    status: order.status,
    paymentStatus: order.payment_status,
    paymentMethod: order.payment_method ?? COUNTER_PAYMENT_METHOD,
    fulfillmentType,
    currencyCode: order.currency_code,
    total: order.total_amount
      ? Number(order.total_amount).toFixed(2)
      : "0.00",
    deliveryFee:
      fulfillmentType === FulfillmentType.DELIVERY && fee != null
        ? money(fee)
        : fulfillmentType === FulfillmentType.DELIVERY
          ? "0.00"
          : null,
    address:
      fulfillmentType === FulfillmentType.DELIVERY
        ? addressViewFromSnapshot(order.delivery_address_snapshot)
        : null,
    customer: {
      id: order.customer.id,
      name: order.customer.name ?? null,
      phone: order.customer.phone_number
    },
    items: order.order_item.map((line) => {
      const unit = new Prisma.Decimal(line.unit_price);
      return {
        menuItemId: line.menu_item_id,
        name: line.menu_item.name,
        quantity: line.quantity,
        variation: line.variation ?? null,
        notes: line.notes ?? null,
        unitPrice: unit.toFixed(2),
        lineTotal: unit.mul(line.quantity).toFixed(2)
      };
    }),
    createdAt: order.created_at.toISOString()
  };
}
