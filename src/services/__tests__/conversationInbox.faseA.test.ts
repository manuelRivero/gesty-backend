import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    business_user: {
      findFirst: vi.fn(),
      findUnique: vi.fn()
    },
    conversation: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn()
    },
    conversation_state: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn()
    }
  }
}));

vi.mock("../../repositories/conversationState.repository", () => ({
  findOrCreateConversationState: vi.fn().mockResolvedValue({}),
  updateConversationState: vi.fn().mockResolvedValue({})
}));

vi.mock("../../socket/adminSocket", () => ({
  emitAdminWhatsappAssignmentUpdated: vi.fn(),
  emitAdminWhatsappBotAutoReactivated: vi.fn(),
  emitAdminWhatsappSupportAcked: vi.fn()
}));

import { prisma } from "../../lib/prisma";
import { updateConversationState } from "../../repositories/conversationState.repository";
import {
  emitAdminWhatsappAssignmentUpdated,
  emitAdminWhatsappBotAutoReactivated,
  emitAdminWhatsappSupportAcked
} from "../../socket/adminSocket";
import {
  assignConversation,
  ConversationAssignmentError
} from "../conversationAssignment.service";
import { setConversationHumanHandled } from "../conversationHumanHandled.service";
import { ackConversationSupport } from "../conversationSupportAck.service";

const mockedFindMembership = prisma.business_user.findFirst as unknown as ReturnType<
  typeof vi.fn
>;
const mockedFindConversation = prisma.conversation.findFirst as unknown as ReturnType<
  typeof vi.fn
>;
const mockedUpdateConversation = prisma.conversation.update as unknown as ReturnType<
  typeof vi.fn
>;
const mockedFindUniqueConversation = prisma.conversation
  .findUnique as unknown as ReturnType<typeof vi.fn>;

describe("assignConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asigna sin tocar is_human_handled", async () => {
    mockedFindConversation.mockResolvedValue({ id: "conv-1" });
    mockedFindMembership.mockResolvedValue({ id: "mem-1" });
    mockedUpdateConversation.mockResolvedValue({
      id: "conv-1",
      assigned_at: new Date("2026-09-06T12:00:00.000Z"),
      assigned_business_user: {
        id: "mem-1",
        user_id: "user-1",
        role: "ADMIN",
        app_user: { name: "Ana" }
      }
    });

    const result = await assignConversation({
      businessId: "biz-1",
      conversationId: "conv-1",
      businessUserId: "mem-1"
    });

    expect(result.assignedUser?.id).toBe("mem-1");
    expect(result.assignedUser?.name).toBe("Ana");
    expect(updateConversationState).not.toHaveBeenCalled();
    expect(emitAdminWhatsappAssignmentUpdated).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({ conversationId: "conv-1" })
    );
  });

  it("rechaza membresía no asignable", async () => {
    mockedFindConversation.mockResolvedValue({ id: "conv-1" });
    mockedFindMembership.mockResolvedValue(null);

    await expect(
      assignConversation({
        businessId: "biz-1",
        conversationId: "conv-1",
        businessUserId: "mem-delivery"
      })
    ).rejects.toBeInstanceOf(ConversationAssignmentError);
  });
});

describe("setConversationHumanHandled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("limpia assignee al reactivar bot (D6) y emite auto-timeout", async () => {
    mockedFindUniqueConversation.mockResolvedValue({
      assigned_business_user_id: "mem-1"
    });
    mockedUpdateConversation.mockResolvedValue({});

    await setConversationHumanHandled({
      conversationId: "conv-1",
      businessId: "biz-1",
      humanHandled: false,
      reason: "auto_timeout"
    });

    expect(updateConversationState).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({ is_human_handled: false })
    );
    expect(mockedUpdateConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          assigned_business_user_id: null,
          assigned_at: null
        }
      })
    );
    expect(emitAdminWhatsappBotAutoReactivated).toHaveBeenCalledWith("biz-1", {
      conversationId: "conv-1"
    });
  });
});

describe("ackConversationSupport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persiste ack y emite socket", async () => {
    mockedFindConversation.mockResolvedValue({
      id: "conv-1",
      support_requested_at: new Date("2026-09-06T10:00:00.000Z"),
      support_acked_at: null,
      support_acked_by_business_user_id: null
    });
    mockedUpdateConversation.mockResolvedValue({
      id: "conv-1",
      support_requested_at: new Date("2026-09-06T10:00:00.000Z"),
      support_acked_at: new Date("2026-09-06T10:05:00.000Z"),
      support_acked_by_business_user_id: "mem-1"
    });
    (prisma.business_user.findUnique as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "mem-1",
      user_id: "user-1",
      role: "ADMIN",
      app_user: { name: "Ana" }
    });

    const result = await ackConversationSupport({
      businessId: "biz-1",
      conversationId: "conv-1",
      actorBusinessUserId: "mem-1"
    });

    expect(result.alreadyAcked).toBe(false);
    expect(result.ackedBy?.name).toBe("Ana");
    expect(emitAdminWhatsappSupportAcked).toHaveBeenCalled();
  });

  it("es idempotente si ya estaba acked", async () => {
    mockedFindConversation.mockResolvedValue({
      id: "conv-1",
      support_requested_at: new Date("2026-09-06T10:00:00.000Z"),
      support_acked_at: new Date("2026-09-06T10:05:00.000Z"),
      support_acked_by_business_user_id: "mem-1"
    });
    (prisma.business_user.findUnique as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "mem-1",
      user_id: "user-1",
      role: "ADMIN",
      app_user: { name: "Ana" }
    });

    const result = await ackConversationSupport({
      businessId: "biz-1",
      conversationId: "conv-1",
      actorBusinessUserId: "mem-2"
    });

    expect(result.alreadyAcked).toBe(true);
    expect(mockedUpdateConversation).not.toHaveBeenCalled();
  });
});
