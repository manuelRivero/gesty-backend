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

describe('routeAfterDetectionContext — Ownership vs prosa', () => {
  it('texto libre (nlp) va al subgrafo NLP, no al Closer', () => {
    expect(routeAfterDetectionContext(state('nlp'))).toBe(NODE.NLP);
  });

  it('sesión checkout no entra a nlp', () => {
    expect(routeAfterDetectionContext(state('checkout'))).toBe(NODE.CHECKOUT_AGENT);
  });

  it('botón (interactive) va al mapper, no al ReAct', () => {
    expect(routeAfterDetectionContext(state('interactive'))).toBe(NODE.INTERACTIVE);
  });
});
