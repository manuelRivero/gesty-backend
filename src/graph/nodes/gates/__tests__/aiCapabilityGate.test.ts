import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentState } from '../../../state';
import { aiCapabilityGateNode } from '../index';

vi.mock('../../../../services/billing/businessCapabilities.service', () => ({
  resolveBusinessCapabilities: vi.fn(),
}));

vi.mock('../../../../config/env', () => ({
  env: { STOREFRONT_PUBLIC_ORIGIN: 'https://shop.gesty.online' },
}));

import { resolveBusinessCapabilities } from '../../../../services/billing/businessCapabilities.service';

const mockedResolve = resolveBusinessCapabilities as unknown as ReturnType<typeof vi.fn>;

function baseState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    business: { id: 'biz-1', slug: 'pizza-juan' },
    isOwnerAssistant: false,
    ...overrides,
  } as unknown as AgentState;
}

describe('aiCapabilityGateNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deja pasar sin tocar el estado cuando la IA está habilitada', async () => {
    mockedResolve.mockResolvedValue({
      ai: { allowed: true, reason: 'ok' },
      shopping: { allowed: true, reason: 'ok' },
    });
    const result = await aiCapabilityGateNode(baseState());
    expect(result).toEqual({});
  });

  it('corta con earlyExit + mensaje fijo (con link) cuando el plan no habilita IA', async () => {
    mockedResolve.mockResolvedValue({
      ai: { allowed: false, reason: 'plan_ai_disabled' },
      shopping: { allowed: true, reason: 'ok' },
    });
    const result = await aiCapabilityGateNode(baseState());
    expect(result.earlyExit).toBe('ai_capability_blocked');
    expect(result.aiCapabilityBlocked).toBe(true);
    expect(result.handlerResult?.isInteractive).toBe(false);
    expect(result.handlerResult?.skipBodyHumanization).toBe(true);
    expect(typeof result.handlerResult?.content).toBe('string');
    expect(result.handlerResult?.content as string).toContain(
      'https://shop.gesty.online/shopping/pizza-juan'
    );
    // No afirma que el negocio cerró o dejó de vender.
    expect((result.handlerResult?.content as string).toLowerCase()).not.toContain('cerrado');
  });

  it('omite el link si el negocio no tiene slug', async () => {
    mockedResolve.mockResolvedValue({
      ai: { allowed: false, reason: 'plan_ai_disabled' },
      shopping: { allowed: true, reason: 'ok' },
    });
    const result = await aiCapabilityGateNode(baseState({ business: { id: 'biz-1', slug: null } as never }));
    expect(result.handlerResult?.content as string).not.toContain('http');
  });

  it('NO exime a isOwnerAssistant: el dueño no puede saltarse IA desautorizada', async () => {
    mockedResolve.mockResolvedValue({
      ai: { allowed: false, reason: 'plan_ai_disabled' },
      shopping: { allowed: true, reason: 'ok' },
    });
    const result = await aiCapabilityGateNode(baseState({ isOwnerAssistant: true }));
    expect(mockedResolve).toHaveBeenCalledWith('biz-1');
    expect(result.earlyExit).toBe('ai_capability_blocked');
  });

  it('deniega también cuando la resolución falla cerrada (no_subscription / resolution_error)', async () => {
    mockedResolve.mockResolvedValue({
      ai: { allowed: false, reason: 'resolution_error' },
      shopping: { allowed: false, reason: 'resolution_error' },
    });
    const result = await aiCapabilityGateNode(baseState());
    expect(result.earlyExit).toBe('ai_capability_blocked');
  });
});
