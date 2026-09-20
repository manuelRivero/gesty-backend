import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../socket/adminSocket", () => ({
  emitAdminWhatsappViewersUpdated: vi.fn()
}));

import { emitAdminWhatsappViewersUpdated } from "../../socket/adminSocket";
import {
  __resetConversationViewersForTests,
  touchConversationViewer
} from "../conversationViewers.service";

describe("touchConversationViewer", () => {
  beforeEach(() => {
    __resetConversationViewersForTests();
    vi.clearAllMocks();
  });

  it("acumula viewers y emite socket", () => {
    touchConversationViewer({
      businessId: "biz-1",
      conversationId: "conv-1",
      businessUserId: "mem-1",
      name: "Ana"
    });
    const result = touchConversationViewer({
      businessId: "biz-1",
      conversationId: "conv-1",
      businessUserId: "mem-2",
      name: "Luis"
    });

    expect(result.viewers).toHaveLength(2);
    expect(emitAdminWhatsappViewersUpdated).toHaveBeenCalled();
  });
});
