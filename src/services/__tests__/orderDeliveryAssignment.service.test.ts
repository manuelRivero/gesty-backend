import { FulfillmentType, OrderStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    business_user: {
      findFirst: vi.fn()
    },
    orders: {
      findFirst: vi.fn(),
      update: vi.fn()
    }
  }
}));

vi.mock("../adminOrders.service", () => ({
  getAdminOrderById: vi.fn()
}));

import { prisma } from "../../lib/prisma";
import { getAdminOrderById } from "../adminOrders.service";
import {
  assignOrderDelivery,
  canDeliveryAccessOrder,
  OrderDeliveryAssignmentError
} from "../orderDeliveryAssignment.service";

const mockedFindMembership = prisma.business_user.findFirst as unknown as ReturnType<
  typeof vi.fn
>;
const mockedFindOrder = prisma.orders.findFirst as unknown as ReturnType<
  typeof vi.fn
>;
const mockedUpdateOrder = prisma.orders.update as unknown as ReturnType<
  typeof vi.fn
>;
const mockedGetAdminOrderById = getAdminOrderById as unknown as ReturnType<
  typeof vi.fn
>;

describe("canDeliveryAccessOrder", () => {
  it("permite acceso cuando el pedido DELIVERY está asignado al actor", () => {
    expect(
      canDeliveryAccessOrder({
        order: {
          fulfillment_type: FulfillmentType.DELIVERY,
          assigned_delivery_user_id: "mem-1"
        },
        actorBusinessUserId: "mem-1"
      })
    ).toBe(true);
  });

  it("deniega acceso si el pedido no está asignado al actor", () => {
    expect(
      canDeliveryAccessOrder({
        order: {
          fulfillment_type: FulfillmentType.DELIVERY,
          assigned_delivery_user_id: "mem-2"
        },
        actorBusinessUserId: "mem-1"
      })
    ).toBe(false);
  });

  it("deniega acceso si el pedido no tiene asignación", () => {
    expect(
      canDeliveryAccessOrder({
        order: {
          fulfillment_type: FulfillmentType.DELIVERY,
          assigned_delivery_user_id: null
        },
        actorBusinessUserId: "mem-1"
      })
    ).toBe(false);
  });

  it("deniega acceso para take-away aunque coincida el id", () => {
    expect(
      canDeliveryAccessOrder({
        order: {
          fulfillment_type: FulfillmentType.TAKE_AWAY,
          assigned_delivery_user_id: "mem-1"
        },
        actorBusinessUserId: "mem-1"
      })
    ).toBe(false);
  });
});

describe("assignOrderDelivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asigna un repartidor válido a un pedido DELIVERY", async () => {
    mockedFindOrder.mockResolvedValue({
      id: "order-1",
      status: OrderStatus.placed,
      fulfillment_type: FulfillmentType.DELIVERY
    });
    mockedFindMembership.mockResolvedValue({ id: "mem-delivery-1" });
    mockedUpdateOrder.mockResolvedValue({});
    mockedGetAdminOrderById.mockResolvedValue({
      id: "order-1",
      assigned_delivery_user_id: "mem-delivery-1"
    });

    const order = await assignOrderDelivery({
      businessId: "biz-1",
      orderId: "order-1",
      assignedDeliveryUserId: "mem-delivery-1"
    });

    expect(mockedUpdateOrder).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { assigned_delivery_user_id: "mem-delivery-1" }
    });
    expect(order.assigned_delivery_user_id).toBe("mem-delivery-1");
  });

  it("desasigna cuando assignedDeliveryUserId es null", async () => {
    mockedFindOrder.mockResolvedValue({
      id: "order-1",
      status: OrderStatus.preparing,
      fulfillment_type: FulfillmentType.DELIVERY
    });
    mockedUpdateOrder.mockResolvedValue({});
    mockedGetAdminOrderById.mockResolvedValue({
      id: "order-1",
      assigned_delivery_user_id: null
    });

    await assignOrderDelivery({
      businessId: "biz-1",
      orderId: "order-1",
      assignedDeliveryUserId: null
    });

    expect(mockedUpdateOrder).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { assigned_delivery_user_id: null }
    });
    expect(mockedFindMembership).not.toHaveBeenCalled();
  });

  it("rechaza asignar a usuario que no es DELIVERY", async () => {
    mockedFindOrder.mockResolvedValue({
      id: "order-1",
      status: OrderStatus.placed,
      fulfillment_type: FulfillmentType.DELIVERY
    });
    mockedFindMembership.mockResolvedValue(null);

    await expect(
      assignOrderDelivery({
        businessId: "biz-1",
        orderId: "order-1",
        assignedDeliveryUserId: "mem-admin"
      })
    ).rejects.toMatchObject({
      code: "NOT_DELIVERY_USER"
    } satisfies Partial<OrderDeliveryAssignmentError>);
  });

  it("rechaza asignar take-away", async () => {
    mockedFindOrder.mockResolvedValue({
      id: "order-1",
      status: OrderStatus.placed,
      fulfillment_type: FulfillmentType.TAKE_AWAY
    });

    await expect(
      assignOrderDelivery({
        businessId: "biz-1",
        orderId: "order-1",
        assignedDeliveryUserId: "mem-delivery-1"
      })
    ).rejects.toMatchObject({
      code: "ORDER_NOT_DELIVERY"
    } satisfies Partial<OrderDeliveryAssignmentError>);
  });

  it("rechaza reasignar pedido entregado", async () => {
    mockedFindOrder.mockResolvedValue({
      id: "order-1",
      status: OrderStatus.delivered,
      fulfillment_type: FulfillmentType.DELIVERY
    });

    await expect(
      assignOrderDelivery({
        businessId: "biz-1",
        orderId: "order-1",
        assignedDeliveryUserId: "mem-delivery-1"
      })
    ).rejects.toMatchObject({
      code: "ORDER_ALREADY_DELIVERED"
    } satisfies Partial<OrderDeliveryAssignmentError>);
  });

  it("rechaza orden inexistente", async () => {
    mockedFindOrder.mockResolvedValue(null);

    await expect(
      assignOrderDelivery({
        businessId: "biz-1",
        orderId: "order-1",
        assignedDeliveryUserId: "mem-delivery-1"
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND"
    } satisfies Partial<OrderDeliveryAssignmentError>);
  });
});
