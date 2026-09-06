import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentState } from '../../../state';
import {
  capabilityAccessGateNode,
} from '../index';

vi.mock('../../../../services/evaluateBusinessCapabilityAccess.service', () => ({
  evaluateBusinessCapabilityAccess: vi.fn(),
}));

import { evaluateBusinessCapabilityAccess } from '../../../../services/evaluateBusinessCapabilityAccess.service';

const mockedEval = evaluateBusinessCapabilityAccess as unknown as ReturnType<
  typeof vi.fn
>;

function baseState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    business: { id: 'biz-1' },
    businessConfig: { orders_enabled: false, reservations_enabled: false },
    isOwnerAssistant: false,
    ...overrides,
  } as unknown as AgentState;
}

describe('capabilityAccessGateNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bloquea con earlyExit cuando mode=blocked', async () => {
    mockedEval.mockResolvedValue({
      mode: 'blocked',
      message: 'bloqueado',
      canOrder: false,
      hasReservations: false,
    });
    const result = await capabilityAccessGateNode(baseState());
    expect(result.earlyExit).toBe('capabilities_blocked');
    expect(result.handlerResult).toEqual({
      content: 'bloqueado',
      isInteractive: false,
    });
  });

  it('deja pasar reservations_only', async () => {
    mockedEval.mockResolvedValue({
      mode: 'reservations_only',
      message: null,
      canOrder: false,
      hasReservations: true,
    });
    const result = await capabilityAccessGateNode(baseState());
    expect(result.earlyExit).toBeUndefined();
    expect(result.handlerResult).toBeUndefined();
  });

  it('exime owner assistant (D17)', async () => {
    const result = await capabilityAccessGateNode(
      baseState({ isOwnerAssistant: true })
    );
    expect(mockedEval).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });
});
