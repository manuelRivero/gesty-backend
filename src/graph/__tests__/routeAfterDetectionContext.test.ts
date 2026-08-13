import { describe, expect, it } from 'vitest';
import { NODE, routeAfterDetectionContext } from '../routers';
import type { AgentState } from '../state';

const state = (contextRoute: AgentState['contextRoute']): AgentState =>
  ({ contextRoute, earlyExit: null }) as AgentState;

describe('routeAfterDetectionContext — owner_assistant', () => {
  it('rutea al nodo del dueño', () => {
    expect(routeAfterDetectionContext(state('owner_assistant'))).toBe(
      NODE.OWNER_ASSISTANT
    );
  });
});
