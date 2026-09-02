import { FulfillmentType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
    orders: {
      count: vi.fn(),
      findMany: vi.fn()
    }
  }
}));

import { prisma } from "../../lib/prisma";
import { listAdminOrders } from "../adminOrders.service";

const mockedTransaction = prisma.$transaction as unknown as ReturnType<
  typeof vi.fn
>;
const mockedCount = prisma.orders.count as unknown as ReturnType<typeof vi.fn>;
const mockedFindMany = prisma.orders.findMany as unknown as ReturnType<
  typeof vi.fn
>;

describe("listAdminOrders delivery assignment filters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedCount.mockResolvedValue(0);
    mockedFindMany.mockResolvedValue([]);
    mockedTransaction.mockImplementation(async (ops: Promise<unknown>[]) =>
      Promise.all(ops)
    );
  });

  it("DELIVERY solo ve pedidos asignados a su membresía y tipo DELIVERY", async () => {
    await listAdminOrders({
      businessId: "biz-1",
      page: 1,
      pageSize: 20,
      actorRole: "DELIVERY",
      actorBusinessUserId: "mem-delivery-1"
    });

    expect(mockedCount).toHaveBeenCalledWith({
      where: {
        business_id: "biz-1",
        fulfillment_type: FulfillmentType.DELIVERY,
        assigned_delivery_user_id: "mem-delivery-1"
      }
    });
  });

  it("DELIVERY sin membresía resuelta devuelve lista vacía por filtro imposible", async () => {
    await listAdminOrders({
      businessId: "biz-1",
      page: 1,
      pageSize: 20,
      actorRole: "DELIVERY"
    });

    expect(mockedCount).toHaveBeenCalledWith({
      where: {
        business_id: "biz-1",
        fulfillment_type: FulfillmentType.DELIVERY,
        id: { in: [] }
      }
    });
  });

  it("OWNER puede filtrar pedidos sin asignar", async () => {
    await listAdminOrders({
      businessId: "biz-1",
      page: 1,
      pageSize: 20,
      actorRole: "OWNER",
      assignment: "unassigned"
    });

    expect(mockedCount).toHaveBeenCalledWith({
      where: {
        business_id: "biz-1",
        assigned_delivery_user_id: null
      }
    });
  });

  it("OWNER puede filtrar por repartidor asignado", async () => {
    await listAdminOrders({
      businessId: "biz-1",
      page: 1,
      pageSize: 20,
      actorRole: "ADMIN",
      assignedDeliveryUserId: "mem-delivery-2"
    });

    expect(mockedCount).toHaveBeenCalledWith({
      where: {
        business_id: "biz-1",
        assigned_delivery_user_id: "mem-delivery-2"
      }
    });
  });
});
