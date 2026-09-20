import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    business_config: {
      findMany: vi.fn()
    },
    conversation: {
      findMany: vi.fn()
    }
  }
}));

vi.mock("../../services/conversationHumanHandled.service", () => ({
  setConversationHumanHandled: vi.fn().mockResolvedValue(undefined)
}));

import { prisma } from "../../lib/prisma";
import { setConversationHumanHandled } from "../../services/conversationHumanHandled.service";
import { processHumanHandoffTimeouts } from "../../workers/humanHandoffTimeout";

describe("processHumanHandoffTimeouts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reactiva conversaciones humanas idle según config", async () => {
    (prisma.business_config.findMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { business_id: "biz-1", human_handoff_auto_timeout_minutes: 15 }
    ]);
    (prisma.conversation.findMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "conv-1" },
      { id: "conv-2" }
    ]);

    const result = await processHumanHandoffTimeouts();

    expect(result.reactivated).toBe(2);
    expect(setConversationHumanHandled).toHaveBeenCalledTimes(2);
    expect(setConversationHumanHandled).toHaveBeenCalledWith({
      conversationId: "conv-1",
      businessId: "biz-1",
      humanHandled: false,
      reason: "auto_timeout"
    });
  });

  it("no hace nada sin configs con timeout", async () => {
    (prisma.business_config.findMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await processHumanHandoffTimeouts();

    expect(result.reactivated).toBe(0);
    expect(setConversationHumanHandled).not.toHaveBeenCalled();
  });
});
