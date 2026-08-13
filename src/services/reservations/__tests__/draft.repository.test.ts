/**
 * P0.1 (R-A): `patchReservationDraft` nunca puede borrar un Fact que no le
 * pertenece — lee el draft existente y mergea antes de persistir.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    conversation_state: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
}));

import { prisma } from '../../../lib/prisma';
import { patchReservationDraft, readReservationDraft } from '../draft.repository';

const mockedFindFirst = prisma.conversation_state.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedFindUnique = prisma.conversation_state.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedUpdate = prisma.conversation_state.update as unknown as ReturnType<typeof vi.fn>;

describe('patchReservationDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('guardar la fecha después de personas conserva partySize', async () => {
    mockedFindFirst.mockResolvedValue({
      metadata: { reservation_draft: { partySize: 4, slotId: 'slot-1' } },
    });
    mockedFindUnique.mockResolvedValue({
      metadata: { reservation_draft: { partySize: 4, slotId: 'slot-1' } },
    });
    mockedUpdate.mockResolvedValue({});

    const merged = await patchReservationDraft('conv-1', { date: '20/08/2026' });

    expect(merged).toEqual({ partySize: 4, slotId: 'slot-1', date: '20/08/2026' });
    expect(mockedUpdate).toHaveBeenCalledWith({
      where: { conversation_id: 'conv-1' },
      data: {
        metadata: {
          reservation_draft: { partySize: 4, slotId: 'slot-1', date: '20/08/2026' },
        },
      },
    });
  });

  it('sin draft previo, escribe solo el parcial', async () => {
    mockedFindFirst.mockResolvedValue(null);
    mockedFindUnique.mockResolvedValue(null);
    mockedUpdate.mockResolvedValue({});

    const merged = await patchReservationDraft('conv-2', { partySize: 2 });

    expect(merged).toEqual({ partySize: 2 });
  });
});

describe('readReservationDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('devuelve {} si no hay conversation_state', async () => {
    mockedFindFirst.mockResolvedValue(null);
    expect(await readReservationDraft('conv-x')).toEqual({});
  });

  it('devuelve una copia del draft persistido', async () => {
    mockedFindFirst.mockResolvedValue({ metadata: { reservation_draft: { date: '01/01/2026' } } });
    expect(await readReservationDraft('conv-y')).toEqual({ date: '01/01/2026' });
  });
});
