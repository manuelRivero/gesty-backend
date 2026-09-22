import { describe, it, expect } from 'vitest';
import { shouldClearConversationCanvas } from '../conversationCanvas.service';

describe('shouldClearConversationCanvas', () => {
  it('limpia si no queda dueño', () => {
    expect(shouldClearConversationCanvas({ metadata: {}, hasCartItems: false })).toBe(true);
    expect(
      shouldClearConversationCanvas({
        metadata: { checkout_active: false, pending_address_confirmation: false },
        hasCartItems: false,
      })
    ).toBe(true);
  });

  it('no limpia si hay dueño de dominio', () => {
    expect(
      shouldClearConversationCanvas({
        metadata: { reservation_agent_active: true },
        hasCartItems: false,
      })
    ).toBe(false);
    expect(
      shouldClearConversationCanvas({
        metadata: { reservation_draft: { partySize: 3 } },
        hasCartItems: false,
      })
    ).toBe(false);
    expect(
      shouldClearConversationCanvas({
        metadata: { checkout_active: true },
        hasCartItems: false,
      })
    ).toBe(false);
    expect(shouldClearConversationCanvas({ metadata: {}, hasCartItems: true })).toBe(false);
    expect(
      shouldClearConversationCanvas({
        metadata: { onboarding_agent_active: true },
        hasCartItems: false,
      })
    ).toBe(false);
  });
});
