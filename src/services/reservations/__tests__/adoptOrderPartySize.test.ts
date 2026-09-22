import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findFirstMock, patchReservationDraftMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  patchReservationDraftMock: vi.fn(),
}));

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    conversation_state: { findFirst: (...args: unknown[]) => findFirstMock(...args) },
  },
}));

vi.mock('../draft.repository', () => ({
  patchReservationDraft: (...args: unknown[]) => patchReservationDraftMock(...args),
}));

import { adoptOrderPartySizeIntoReservationDraft } from '../adoptOrderPartySize';

describe('adoptOrderPartySizeIntoReservationDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adopta peopleCount del pedido cuando el draft no tiene personas', async () => {
    findFirstMock.mockResolvedValue({ metadata: { peopleCount: 6 } });

    const adopted = await adoptOrderPartySizeIntoReservationDraft('conv-1');

    expect(adopted).toBe(6);
    expect(patchReservationDraftMock).toHaveBeenCalledWith('conv-1', { partySize: 6 });
  });

  it('lee fresco: el save_party_size del mismo turno se adopta igual', async () => {
    // El snapshot del turno no tenía el Fact; la DB sí.
    findFirstMock.mockResolvedValue({
      metadata: { peopleCount: 6, requestedPartySize: 6, reservation_draft: {} },
    });

    const adopted = await adoptOrderPartySizeIntoReservationDraft('conv-1');

    expect(adopted).toBe(6);
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { conversation_id: 'conv-1' },
      select: { metadata: true },
    });
  });

  it('gana el draft si ya tiene partySize', async () => {
    findFirstMock.mockResolvedValue({
      metadata: { peopleCount: 6, reservation_draft: { partySize: 4 } },
    });

    const adopted = await adoptOrderPartySizeIntoReservationDraft('conv-1');

    expect(adopted).toBeNull();
    expect(patchReservationDraftMock).not.toHaveBeenCalled();
  });

  it('sin Fact de personas no escribe nada', async () => {
    findFirstMock.mockResolvedValue({ metadata: {} });

    const adopted = await adoptOrderPartySizeIntoReservationDraft('conv-1');

    expect(adopted).toBeNull();
    expect(patchReservationDraftMock).not.toHaveBeenCalled();
  });
});
