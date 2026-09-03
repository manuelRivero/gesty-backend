import { describe, expect, it } from "vitest";
import {
  PAID_PLAN_CATALOG,
  TOKENS_PER_CONVERSATION,
  TRIAL_CONVERSATIONS,
  conversationsFromTokenLimit,
  tokenLimitFromConversations,
} from "../planCatalog";

describe("planCatalog comercial gesty.online", () => {
  it("Basic 100k tokens ≈ 2.500 conversaciones", () => {
    const basic = PAID_PLAN_CATALOG.find((p) => p.code === "basic")!;
    expect(basic.monthly_price_usd).toBe("45.00");
    expect(basic.token_limit).toBe(100_000);
    expect(basic.conversations_per_month).toBe(2500);
    expect(conversationsFromTokenLimit(basic.token_limit)).toBe(2500);
  });

  it("Pro y Business siguen el mismo ratio", () => {
    expect(tokenLimitFromConversations(7000)).toBe(280_000);
    expect(tokenLimitFromConversations(20000)).toBe(800_000);
    expect(PAID_PLAN_CATALOG.find((p) => p.code === "pro")?.token_limit).toBe(
      280_000
    );
    expect(
      PAID_PLAN_CATALOG.find((p) => p.code === "business")?.token_limit
    ).toBe(800_000);
  });

  it("trial ~500 conv", () => {
    expect(TRIAL_CONVERSATIONS * TOKENS_PER_CONVERSATION).toBe(20_000);
  });
});
