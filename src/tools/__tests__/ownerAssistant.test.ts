import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/env', () => ({
  isOwnerAssistantEnabled: vi.fn(() => true),
}));

vi.mock('../../services/businessConfig.service', () => ({
  getBusinessConfig: vi.fn(),
}));

vi.mock('../../services/ownerAssistant/buildOwnerMetricsSnapshot', () => ({
  buildOwnerMetricsSnapshot: vi.fn(),
}));

vi.mock('../../services/ownerAssistant/ownerOrdersSnapshot.service', () => ({
  getLiveOrdersSnapshot: vi.fn(),
}));

vi.mock('../../services/ownerAssistant/ownerOrderDetail.service', () => ({
  getOwnerOrderDetail: vi.fn(),
}));

import { isOwnerAssistantEnabled } from '../../config/env';
import { getBusinessConfig } from '../../services/businessConfig.service';
import { buildOwnerMetricsSnapshot } from '../../services/ownerAssistant/buildOwnerMetricsSnapshot';
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
  });

  it('rechaza si el teléfono no está en la allowlist y no llama al snapshot', async () => {
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
    expect(buildOwnerMetricsSnapshot).not.toHaveBeenCalled();
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
    expect(buildOwnerMetricsSnapshot).not.toHaveBeenCalled();
  });

  it('deja pasar al dueño y pide el snapshot de hoy', async () => {
    vi.mocked(getBusinessConfig).mockResolvedValue({
      owner_whatsapp_phones: [OWNER_PHONE],
    } as never);
    vi.mocked(buildOwnerMetricsSnapshot).mockResolvedValue({
      schemaVersion: 'owner-metrics-v1',
      historical: { orders: { count: 10 } },
    } as never);

    const raw = await getOwnerBriefingTool.func(
      { period: 'today' },
      undefined,
      CONFIG
    );
    const parsed = JSON.parse(raw as string);

    expect(buildOwnerMetricsSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: 'biz-1',
        excludeCustomerId: 'cust-owner',
        period: 'today',
        topProductsLimit: 1,
      })
    );
    expect(parsed.schemaVersion).toBe('owner-metrics-v1');
    expect(parsed.historical.orders.count).toBe(10);
  });
});
