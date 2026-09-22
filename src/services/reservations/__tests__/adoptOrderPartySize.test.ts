import { describe, it, expect, vi, beforeEach } from 'vitest';

const { readReservationDraftMock, patchReservationDraftMock } = vi.hoisted(() => ({
  readReservationDraftMock: vi.fn(),
  patchReservationDraftMock: vi.fn(),
}));

vi.mock('../draft.repository', () => ({
  readReservationDraft: (...args: unknown[]) => readReservationDraftMock(...args),
  patchReservationDraft: (...args: unknown[]) => patchReservationDraftMock(...args),
}));

import { adoptOrderPartySizeIntoReservationDraft } from '../adoptOrderPartySize';

describe('adoptOrderPartySizeIntoReservationDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readReservationDraftMock.mockResolvedValue({});
  });

  it('adopta peopleCount del pedido cuando el draft no tiene personas', async () => {
    const adopted = await adoptOrderPartySizeIntoReservationDraft({
      conversationId: 'conv-1',
      metadata: { peopleCount: 6 },
    });

    expect(adopted).toBe(6);
    expect(patchReservationDraftMock).toHaveBeenCalledWith('conv-1', { partySize: 6 });
  });

  it('gana el draft si ya tiene partySize', async () => {
    readReservationDraftMock.mockResolvedValue({ partySize: 4 });

    const adopted = await adoptOrderPartySizeIntoReservationDraft({
      conversationId: 'conv-1',
      metadata: { peopleCount: 6 },
    });

    expect(adopted).toBeNull();
    expect(patchReservationDraftMock).not.toHaveBeenCalled();
  });

  it('sin Fact de personas no escribe nada', async () => {
    const adopted = await adoptOrderPartySizeIntoReservationDraft({
      conversationId: 'conv-1',
      metadata: {},
    });

    expect(adopted).toBeNull();
    expect(patchReservationDraftMock).not.toHaveBeenCalled();
  });
});
