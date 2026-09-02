import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    business_user: {
      findFirst: vi.fn()
    }
  }
}));

import { prisma } from "../../lib/prisma";
import { getBusinessUserIdForActor } from "../businessUserContext.service";

const mockedFindFirst = prisma.business_user.findFirst as unknown as ReturnType<
  typeof vi.fn
>;

describe("businessUserContext.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("devuelve business_user.id cuando existe la membresía", async () => {
    mockedFindFirst.mockResolvedValue({ id: "mem-delivery-1" });

    const result = await getBusinessUserIdForActor({
      userId: "user-1",
      businessId: "biz-1"
    });

    expect(result).toBe("mem-delivery-1");
    expect(mockedFindFirst).toHaveBeenCalledWith({
      where: { user_id: "user-1", business_id: "biz-1" },
      select: { id: true }
    });
  });

  it("devuelve null si no hay membresía", async () => {
    mockedFindFirst.mockResolvedValue(null);

    const result = await getBusinessUserIdForActor({
      userId: "user-1",
      businessId: "biz-1"
    });

    expect(result).toBeNull();
  });
});
