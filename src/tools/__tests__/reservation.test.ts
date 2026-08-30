/**
 * Gates de las tools de escritura de reservas (P0.3/D7):
 *  - save_reservation_date rechaza formato inválido, fechas pasadas, fechas
 *    fuera del horizonte y fechas que no caen en el día que el cliente nombró.
 *  - save_reservation_party_size rechaza cantidades por encima de la
 *    capacidad combinable del negocio.
 *  - resolve_reservation_confirmation es una señal pura (D3).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    conversation_state: { findFirst: vi.fn() },
    reservation_slot: { findFirst: vi.fn() },
  },
}));

vi.mock('../../repositories/conversationState.repository', () => ({
  patchConversationMetadata: vi.fn(),
  omitConversationMetadataKeys: vi.fn(),
}));

vi.mock('../../repositories/reservation.repository', () => ({
  fetchReservationSlotsForBusinessDate: vi.fn(),
  findAnyFutureOccupyingReservationForCustomer: vi.fn(),
  findActiveEnvironmentsByBusinessId: vi.fn(),
  findActiveTablesByBusinessAndEnvironment: vi.fn(),
  findOverlappingReservationForTable: vi.fn(),
  findReservationBlockAtStart: vi.fn(),
}));

vi.mock('../../services/businessConfig.service', () => ({
  getBusinessConfig: vi.fn(),
}));

import { prisma } from '../../lib/prisma';
import { patchConversationMetadata } from '../../repositories/conversationState.repository';
import { findActiveTablesByBusinessAndEnvironment } from '../../repositories/reservation.repository';
import { getBusinessConfig } from '../../services/businessConfig.service';
import {
  saveReservationDateTool,
  saveReservationPartySizeTool,
  resolveReservationConfirmationTool,
  startReservationSessionTool,
} from '../reservation';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

const mockedFindFirst = prisma.conversation_state.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedPatch = patchConversationMetadata as unknown as ReturnType<typeof vi.fn>;
const mockedTables = findActiveTablesByBusinessAndEnvironment as unknown as ReturnType<typeof vi.fn>;

describe('save_reservation_date — gate (D7/R-G)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFindFirst.mockResolvedValue({ metadata: { reservation_draft: { partySize: 4 } } });
  });

  it('rechaza formato inválido sin persistir', async () => {
    const raw = await saveReservationDateTool.func({ date: '32/13/2025' }, undefined, CONFIG);
    const parsed = JSON.parse(raw) as { saved: boolean; error?: string };
    expect(parsed).toEqual({ saved: false, error: 'invalid_date' });
    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('rechaza una fecha pasada sin persistir', async () => {
    const raw = await saveReservationDateTool.func({ date: '01/01/2000' }, undefined, CONFIG);
    const parsed = JSON.parse(raw) as { saved: boolean; error?: string };
    expect(parsed).toEqual({ saved: false, error: 'past_date' });
    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('persiste una fecha futura válida sin borrar partySize (R-A)', async () => {
    const future = new Date();
    future.setDate(future.getDate() + 10);
    const dd = String(future.getDate()).padStart(2, '0');
    const mm = String(future.getMonth() + 1).padStart(2, '0');
    const yyyy = future.getFullYear();
    const dateStr = `${dd}/${mm}/${yyyy}`;

    const raw = await saveReservationDateTool.func({ date: dateStr }, undefined, CONFIG);
    const parsed = JSON.parse(raw) as { saved: boolean; date?: string };
    expect(parsed).toEqual({ saved: true, date: dateStr });
    expect(mockedPatch).toHaveBeenCalledWith('conv-1', {
      reservation_draft: { partySize: 4, date: dateStr },
    });
  });
});

/**
 * El gate no interpreta lenguaje: verifica el resultado que trajo el agente.
 * Reloj fijo en domingo 30/08/2026 — jueves = 03/09, viernes = 04/09.
 */
describe('save_reservation_date — cruce con el día declarado', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 30, 12, 0, 0));
    mockedFindFirst.mockResolvedValue({ metadata: { reservation_draft: { partySize: 4 } } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rechaza la fecha si no cae en el día que el cliente nombró, y sugiere la correcta', async () => {
    const raw = await saveReservationDateTool.func(
      { date: '03/09/2026', weekday: 'viernes' },
      undefined,
      CONFIG
    );
    expect(JSON.parse(raw)).toEqual({
      saved: false,
      error: 'weekday_mismatch',
      declaredWeekday: 'viernes',
      actualWeekday: 'jueves',
      suggestedDate: '04/09/2026',
    });
    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('persiste cuando la fecha sí cae en el día declarado', async () => {
    const raw = await saveReservationDateTool.func(
      { date: '04/09/2026', weekday: 'viernes' },
      undefined,
      CONFIG
    );
    expect(JSON.parse(raw)).toEqual({ saved: true, date: '04/09/2026' });
    expect(mockedPatch).toHaveBeenCalled();
  });

  it('sin weekday no cruza nada: una fecha explícita del cliente se guarda igual', async () => {
    const raw = await saveReservationDateTool.func({ date: '03/09/2026' }, undefined, CONFIG);
    expect(JSON.parse(raw)).toEqual({ saved: true, date: '03/09/2026' });
  });

  it('rechaza una fecha más allá del horizonte de reservas', async () => {
    const raw = await saveReservationDateTool.func({ date: '30/08/2028' }, undefined, CONFIG);
    const parsed = JSON.parse(raw) as { saved: boolean; error?: string; maxDate?: string };
    expect(parsed.saved).toBe(false);
    expect(parsed.error).toBe('too_far');
    expect(parsed.maxDate).toBe('30/08/2027');
    expect(mockedPatch).not.toHaveBeenCalled();
  });
});

describe('save_reservation_party_size — gate de capacidad (D7/R-G)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFindFirst.mockResolvedValue({ metadata: { reservation_draft: { date: '20/08/2026' } } });
  });

  it('rechaza una cantidad por encima de la capacidad combinable', async () => {
    mockedTables.mockResolvedValue([{ id: 't1', capacity: 4 }, { id: 't2', capacity: 6 }]);

    const raw = await saveReservationPartySizeTool.func({ count: 500 }, undefined, CONFIG);
    const parsed = JSON.parse(raw) as { saved: boolean; error?: string; max?: number };
    expect(parsed).toEqual({ saved: false, error: 'party_size_too_large', max: 10 });
    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('persiste dentro de la capacidad sin borrar date', async () => {
    mockedTables.mockResolvedValue([{ id: 't1', capacity: 4 }, { id: 't2', capacity: 6 }]);

    const raw = await saveReservationPartySizeTool.func({ count: 4 }, undefined, CONFIG);
    const parsed = JSON.parse(raw) as { saved: boolean; partySize?: number };
    expect(parsed).toEqual({ saved: true, partySize: 4 });
    expect(mockedPatch).toHaveBeenCalledWith('conv-1', {
      reservation_draft: { date: '20/08/2026', partySize: 4 },
    });
  });
});

describe('resolve_reservation_confirmation — señal pura (D3)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('nunca persiste ni crea la reserva; solo devuelve la señal', async () => {
    const raw = await resolveReservationConfirmationTool.func({ confirmed: true }, undefined, CONFIG);
    expect(JSON.parse(raw)).toEqual({
      signal: 'resolve_reservation_confirmation',
      confirmed: true,
    });
    expect(mockedPatch).not.toHaveBeenCalled();
  });
});

describe('start_reservation_session — entrada del híbrido (Fase B)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('devuelve la señal cuando el negocio toma reservas', async () => {
    vi.mocked(getBusinessConfig).mockResolvedValue({ reservations_enabled: true } as never);

    const raw = await startReservationSessionTool.func(
      { reason: 'el cliente quiere reservar una mesa' },
      undefined,
      CONFIG
    );

    expect(JSON.parse(raw)).toEqual({
      signal: 'start_reservation_session',
      reason: 'el cliente quiere reservar una mesa',
    });
  });

  it('gate: sin reservas habilitadas no emite la señal', async () => {
    vi.mocked(getBusinessConfig).mockResolvedValue({ reservations_enabled: false } as never);

    const raw = await startReservationSessionTool.func(
      { reason: 'el cliente quiere reservar' },
      undefined,
      CONFIG
    );
    const parsed = JSON.parse(raw) as { success: boolean; error?: string; signal?: string };

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('reservations_disabled');
    expect(parsed.signal).toBeUndefined();
  });
});
