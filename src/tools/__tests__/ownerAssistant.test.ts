import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/env', () => ({
  isOwnerAssistantEnabled: vi.fn(() => true),
}));

vi.mock('../../lib/prisma', () => ({
  prisma: {
    business: { findUnique: vi.fn() },
  },
}));

vi.mock('../../services/businessConfig.service', () => ({
  getBusinessConfig: vi.fn(),
}));

vi.mock('../../services/ownerAssistant/ownerBriefing.service', () => ({
  getOwnerBriefing: vi.fn(),
}));

vi.mock('../../services/ownerAssistant/ownerOrdersSnapshot.service', () => ({
  getLiveOrdersSnapshot: vi.fn(),
}));

vi.mock('../../services/ownerAssistant/ownerOrderDetail.service', () => ({
  getOwnerOrderDetail: vi.fn(),
}));

import { isOwnerAssistantEnabled } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { getBusinessConfig } from '../../services/businessConfig.service';
import { getOwnerBriefing } from '../../services/ownerAssistant/ownerBriefing.service';
import { getOwnerBriefingTool } from '../ownerAssistant';

const OWNER_PHONE = '5491112345678';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-owner',
    customerPhone: OWNER_PHONE,
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

describe('owner_assistant tools — withOwnerGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isOwnerAssistantEnabled).mockReturnValue(true);
    vi.mocked(prisma.business.findUnique).mockResolvedValue({
      timezone: 'America/Argentina/Buenos_Aires',
    } as never);
  });

  it('rechaza si el teléfono no está en la allowlist y no llama al briefing', async () => {
    vi.mocked(getBusinessConfig).mockResolvedValue({
      owner_whatsapp_phones: ['5491199999999'],
    } as never);

    const raw = await getOwnerBriefingTool.func(
      { period: 'today' },
      undefined,
      CONFIG
    );
    const parsed = JSON.parse(raw as string);

    expect(parsed).toEqual({ error: 'owner_required', missing: 'owner' });
    expect(getOwnerBriefing).not.toHaveBeenCalled();
  });

  it('rechaza si el flag está apagado', async () => {
    vi.mocked(isOwnerAssistantEnabled).mockReturnValue(false);
    vi.mocked(getBusinessConfig).mockResolvedValue({
      owner_whatsapp_phones: [OWNER_PHONE],
    } as never);

    const raw = await getOwnerBriefingTool.func(
      { period: 'today' },
      undefined,
      CONFIG
    );
    const parsed = JSON.parse(raw as string);

    expect(parsed).toEqual({ error: 'owner_assistant_disabled' });
    expect(getOwnerBriefing).not.toHaveBeenCalled();
  });

  it('deja pasar al dueño y pide el briefing de hoy', async () => {
    vi.mocked(getBusinessConfig).mockResolvedValue({
      owner_whatsapp_phones: [OWNER_PHONE],
    } as never);
    vi.mocked(getOwnerBriefing).mockResolvedValue({
      headlineHints: { orders: 10, complaints: 0 },
    } as never);

    const raw = await getOwnerBriefingTool.func(
      { period: 'today' },
      undefined,
      CONFIG
    );
    const parsed = JSON.parse(raw as string);

    expect(getOwnerBriefing).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: 'biz-1',
        excludeCustomerId: 'cust-owner',
        from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      })
    );
    expect(parsed.headlineHints.orders).toBe(10);
    expect(parsed.periodPreset).toBe('today');
  });
});
