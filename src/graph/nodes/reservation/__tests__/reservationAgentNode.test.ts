/**
 * Tests de `reservationAgentNode` (P0.3 + §3.11 tipables):
 *  - R-A/R-B: un payload `RESERVATION_SLOT:x` mergea sobre el draft
 *    existente sin perder `date`/`partySize` ya cargados, y el mismo turno
 *    ya ve el slot (lectura fresca, no snapshot local).
 *  - D4: la tarjeta de confirmación sale aunque el LLM no haya llamado
 *    `present_confirmation`, si el paso derivado es `confirm` y el draft
 *    está completo.
 *  - §3.11: tipable slot / party size / confirm / ambiente fulfilled en el nodo
 *    (mismo efecto que botón/tool), sin invocar al ReAct cuando el draft queda listo.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { omitConversationMetadataKeysMock, patchConversationMetadataMock } = vi.hoisted(() => ({
  omitConversationMetadataKeysMock: vi.fn(),
  patchConversationMetadataMock: vi.fn(),
}));

vi.mock('../../../../lib/prisma', () => ({
  prisma: {
    conversation_state: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    environment: { findUnique: vi.fn() },
  },
}));

vi.mock('../../../../repositories/conversationState.repository', () => ({
  omitConversationMetadataKeys: (...args: unknown[]) =>
    omitConversationMetadataKeysMock(...args),
  patchConversationMetadata: (...args: unknown[]) =>
    patchConversationMetadataMock(...args),
}));

vi.mock('../../../../repositories/reservation.repository', () => ({
  fetchReservationSlotsForBusinessDate: vi.fn().mockResolvedValue([]),
  fetchActiveReservationSlotById: vi.fn(),
  findActiveEnvironmentsByBusinessId: vi.fn().mockResolvedValue([]),
  findActiveTablesByBusinessAndEnvironment: vi.fn().mockResolvedValue([]),
  findOverlappingReservationForTable: vi.fn(),
  findReservationBlockAtStart: vi.fn(),
  createReservationWithTables: vi.fn(),
  updateReservationStatus: vi.fn(),
  findAnyFutureOccupyingReservationForCustomer: vi.fn(),
}));

vi.mock('../../../../utils/reservationQr', () => ({
  generateReservationQR: vi.fn(),
}));

vi.mock('../../../../agents/reservationAgent', () => ({
  runReservationAgent: vi.fn(),
  extractConfirmReservationPending: vi.fn(),
  extractSelectEnvironmentPending: vi.fn(),
  extractSelectSlotPending: vi.fn(),
  extractPartySizePending: vi.fn(),
  isValidEnvironmentSelection: vi.fn(
    (environmentId: string | null, environments: Array<{ id: string }>) =>
      environmentId === null || environments.some((e) => e.id === environmentId)
  ),
  isValidSlotSelection: vi.fn(
    (slotId: string, slots: Array<{ id: string }>) => slots.some((s) => s.id === slotId)
  ),
  isValidPartySizeSelection: vi.fn(
    (count: number, maxCapacity: number) =>
      Number.isInteger(count) && count >= 1 && (maxCapacity <= 0 || count <= maxCapacity)
  ),
}));

vi.mock('../../../../services/reservations/capacity', () => ({
  getMaxCombinablePartySize: vi.fn().mockResolvedValue(20),
}));

vi.mock('../../../../services/reservationCompletionGoal.service', () => ({
  getReservationCompletionLedger: vi.fn().mockReturnValue({
    abandonment: false,
    surfaceCount: 0,
    lastSurfacedAt: null,
  }),
  reviveReservationCompletionIfAbandoned: vi.fn(),
}));

// Cortar la cadena de imports pesada del agente principal (reactAgent →
// tools/index → menu.service → openai.service) que instancia un cliente
// OpenAI en el import y rompe el test sin OPENAI_API_KEY.
vi.mock('../../../../agents/reactAgent', () => ({
  runHybridReactAgent: vi.fn(),
}));

const {
  buildCancelOrderMessageMock,
  clearReservationSessionAfterCancelMock,
  clearOrderDomainOnReservationOpenMock,
} = vi.hoisted(() => ({
  buildCancelOrderMessageMock: vi.fn(),
  clearReservationSessionAfterCancelMock: vi.fn(),
  clearOrderDomainOnReservationOpenMock: vi.fn(),
}));

vi.mock('../../../../services/order.service', () => ({
  buildCancelOrderMessage: (...args: unknown[]) => buildCancelOrderMessageMock(...args),
}));

vi.mock('../../../../services/reservationSessionReset.service', () => ({
  clearReservationSessionAfterCancel: (...args: unknown[]) =>
    clearReservationSessionAfterCancelMock(...args),
}));
vi.mock('../../../../services/orderSessionReset.service', () => ({
  clearOrderDomainOnReservationOpen: (...args: unknown[]) =>
    clearOrderDomainOnReservationOpenMock(...args),
}));
vi.mock('../../../../services/ai/detection.service', () => ({
  detectIntentWithConfidence: vi.fn(),
}));
vi.mock('../../../../repositories', () => ({
  findOrCreateConversationState: vi.fn(),
  omitConversationMetadataKeys: (...args: unknown[]) =>
    omitConversationMetadataKeysMock(...args),
  patchConversationMetadata: (...args: unknown[]) =>
    patchConversationMetadataMock(...args),
  updateConversationState: vi.fn(),
}));

import { prisma } from '../../../../lib/prisma';
import { patchConversationMetadata, omitConversationMetadataKeys } from '../../../../repositories/conversationState.repository';
import {
  fetchActiveReservationSlotById,
  fetchReservationSlotsForBusinessDate,
  findActiveEnvironmentsByBusinessId,
  createReservationWithTables,
  findActiveTablesByBusinessAndEnvironment,
  findOverlappingReservationForTable,
  findReservationBlockAtStart,
} from '../../../../repositories/reservation.repository';
import { generateReservationQR } from '../../../../utils/reservationQr';
import {
  runReservationAgent,
  extractConfirmReservationPending,
  extractSelectEnvironmentPending,
  extractSelectSlotPending,
  extractPartySizePending,
} from '../../../../agents/reservationAgent';
import { getMaxCombinablePartySize } from '../../../../services/reservations/capacity';
import { reservationAgentNode } from '../index';
import { runHybridReactAgent } from '../../../../agents/reactAgent';
import { findOrCreateConversationState } from '../../../../repositories';
import type { AgentState } from '../../../state';

const mockedFindFirst = prisma.conversation_state.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedEnvFindUnique = prisma.environment.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedPatch = patchConversationMetadataMock;
const mockedOmit = omitConversationMetadataKeysMock;
const mockedSlot = fetchActiveReservationSlotById as unknown as ReturnType<typeof vi.fn>;
const mockedSlotsForDate = fetchReservationSlotsForBusinessDate as unknown as ReturnType<typeof vi.fn>;
const mockedEnvs = findActiveEnvironmentsByBusinessId as unknown as ReturnType<typeof vi.fn>;
const mockedRunAgent = runReservationAgent as unknown as ReturnType<typeof vi.fn>;
const mockedExtractConfirm = extractConfirmReservationPending as unknown as ReturnType<typeof vi.fn>;
const mockedExtractEnv = extractSelectEnvironmentPending as unknown as ReturnType<typeof vi.fn>;
const mockedExtractSlot = extractSelectSlotPending as unknown as ReturnType<typeof vi.fn>;
const mockedExtractParty = extractPartySizePending as unknown as ReturnType<typeof vi.fn>;
const mockedMaxParty = getMaxCombinablePartySize as unknown as ReturnType<typeof vi.fn>;
const mockedCreate = createReservationWithTables as unknown as ReturnType<typeof vi.fn>;
const mockedTables = findActiveTablesByBusinessAndEnvironment as unknown as ReturnType<typeof vi.fn>;
const mockedOverlap = findOverlappingReservationForTable as unknown as ReturnType<typeof vi.fn>;
const mockedBlock = findReservationBlockAtStart as unknown as ReturnType<typeof vi.fn>;
const mockedQr = generateReservationQR as unknown as ReturnType<typeof vi.fn>;
const mockedHybrid = runHybridReactAgent as unknown as ReturnType<typeof vi.fn>;
const mockedFindState = findOrCreateConversationState as unknown as ReturnType<
  typeof vi.fn
>;

const EXISTING_DRAFT = { date: '20/08/2026', partySize: 4 };

const idleSignals = {
  presentSlots: false,
  presentSlotsDate: null,
  presentEnvironments: false,
  presentConfirmation: false,
  confirmReservationResolved: null,
  delegateToMain: false,
  delegateToMainReason: null,
  handbackReservation: false,
  handbackReservationReason: null,
  abandonReservation: false,
  abandonReservationReason: null,
};

const baseState = (overrides: Partial<AgentState> = {}): AgentState =>
  ({
    business: { id: 'biz-1' } as never,
    customer: { id: 'cust-1', name: 'Ana' } as never,
    conversation: { id: 'conv-1' } as never,
    webhookContext: { payloadId: undefined, message: { text: { body: '' } } } as never,
    enrichedCtx: {} as never,
    workingConversationState: {
      metadata: { reservation_agent_active: true, reservation_draft: EXISTING_DRAFT },
    } as never,
    ...overrides,
  }) as AgentState;

describe('reservationAgentNode — merge de payloads (P0.1/P0.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedEnvs.mockResolvedValue([]);
    mockedSlotsForDate.mockResolvedValue([]);
    mockedMaxParty.mockResolvedValue(20);
    mockedRunAgent.mockResolvedValue({
      text: '🤖\n\nListo',
      signals: idleSignals,
    });
  });

  it('RESERVATION_SLOT:x mergea sobre el draft existente sin borrar date/partySize', async () => {
    mockedSlot.mockResolvedValue({ id: 'slot-1', start_time: '20:00', end_time: '21:00' });
    // Lectura fresca dentro de patchReservationDraft (readReservationDraft usa prisma.conversation_state.findFirst)
    mockedFindFirst.mockResolvedValue({
      metadata: { reservation_draft: EXISTING_DRAFT },
    });

    const state = baseState({
      webhookContext: { payloadId: 'RESERVATION_SLOT:slot-1', message: { text: { body: '' } } } as never,
    });

    await reservationAgentNode(state);

    expect(mockedPatch).toHaveBeenCalledWith('conv-1', {
      reservation_draft: {
        date: '20/08/2026',
        partySize: 4,
        slotId: 'slot-1',
        time: '20:00',
        endTime: '21:00',
      },
    });
  });

  it('al abrir la sesión adopta personas del pedido en el draft y cierra el dominio pedido', async () => {
    mockedFindFirst.mockResolvedValue({ metadata: {} });

    const state = baseState({
      workingConversationState: {
        metadata: { requestedPartySize: 3, peopleCount: 3 },
      } as never,
    });

    await reservationAgentNode(state);

    expect(mockedPatch).toHaveBeenCalledWith('conv-1', {
      reservation_agent_active: true,
    });
    expect(mockedPatch).toHaveBeenCalledWith('conv-1', {
      reservation_draft: { partySize: 3 },
    });
    expect(clearOrderDomainOnReservationOpenMock).toHaveBeenCalledWith('conv-1');
  });

  it('no sobrescribe el partySize del draft con el del pedido', async () => {
    mockedFindFirst.mockResolvedValue({
      metadata: { reservation_draft: { partySize: 8 } },
    });

    const state = baseState({
      workingConversationState: {
        metadata: { reservation_draft: { partySize: 8 }, peopleCount: 3 },
      } as never,
    });

    await reservationAgentNode(state);

    expect(mockedPatch).not.toHaveBeenCalledWith('conv-1', {
      reservation_draft: { partySize: 3 },
    });
    expect(clearOrderDomainOnReservationOpenMock).toHaveBeenCalledWith('conv-1');
  });
});

describe('reservationAgentNode — tarjeta de confirmación por estado (D4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedEnvs.mockResolvedValue([]);
    mockedSlotsForDate.mockResolvedValue([]);
    mockedMaxParty.mockResolvedValue(20);
  });

  it('adjunta la tarjeta aunque el LLM no haya llamado present_confirmation', async () => {
    const completeDraft = {
      date: '20/08/2026',
      slotId: 'slot-1',
      time: '20:00',
      endTime: '21:00',
      partySize: 4,
    };
    mockedFindFirst.mockResolvedValue({ metadata: { reservation_draft: completeDraft } });
    mockedRunAgent.mockResolvedValue({
      text: '🤖\n\nDale,ché',
      signals: {
        ...idleSignals,
        presentConfirmation: false, // el LLM no llamó la señal
      },
    });

    const state = baseState({
      workingConversationState: {
        metadata: { reservation_agent_active: true, reservation_draft: completeDraft },
      } as never,
    });

    const result = await reservationAgentNode(state);

    expect(result.handlerResult?.isInteractive).toBe(true);
    expect(typeof result.handlerResult?.content).toBe('object');
  });
});

describe('reservationAgentNode — tipables fulfilled en el nodo (§3.11)', () => {
  const draftReadyForEnv = {
    date: '20/08/2026',
    slotId: 'slot-1',
    time: '20:00',
    endTime: '21:00',
    partySize: 4,
  };

  const salonPrincipal = { id: 'env-salon', name: 'Salón principal' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedEnvs.mockResolvedValue([salonPrincipal]);
    mockedEnvFindUnique.mockResolvedValue({ name: 'Salón principal' });
    mockedOmit.mockResolvedValue(undefined);
    clearReservationSessionAfterCancelMock.mockResolvedValue(undefined);
    mockedSlotsForDate.mockResolvedValue([]);
    mockedMaxParty.mockResolvedValue(20);
  });

  it('ambiente en prosa fulfilled → persiste y muestra confirmación sin ReAct', async () => {
    mockedFindFirst.mockResolvedValue({ metadata: { reservation_draft: draftReadyForEnv } });
    mockedExtractEnv.mockResolvedValue({
      status: 'fulfilled',
      value: { environmentId: 'env-salon' },
      confidence: 0.95,
      source: 'llm',
      reason: null,
    });

    const state = baseState({
      webhookContext: {
        payloadId: undefined,
        message: { type: 'text', text: { body: 'salón principal' } },
      } as never,
      workingConversationState: {
        metadata: { reservation_agent_active: true, reservation_draft: draftReadyForEnv },
      } as never,
    });

    const result = await reservationAgentNode(state);

    expect(mockedRunAgent).not.toHaveBeenCalled();
    expect(mockedPatch).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        reservation_draft: expect.objectContaining({ environmentId: 'env-salon' }),
      })
    );
    expect(result.handlerResult?.isInteractive).toBe(true);
  });

  it('confirmación en prosa fulfilled → crea la reserva sin ReAct', async () => {
    const completeDraft = { ...draftReadyForEnv, environmentId: 'env-salon' };
    mockedFindFirst.mockResolvedValue({ metadata: { reservation_draft: completeDraft } });
    mockedExtractConfirm.mockResolvedValue({
      status: 'fulfilled',
      value: { confirmed: true },
      confidence: 0.99,
      source: 'llm',
      reason: null,
    });
    mockedSlot.mockResolvedValue({ id: 'slot-1', start_time: '20:00', end_time: '21:00' });
    mockedTables.mockResolvedValue([{ id: 't1', capacity: 6 }]);
    mockedOverlap.mockResolvedValue(null);
    mockedBlock.mockResolvedValue(null);
    mockedCreate.mockResolvedValue({
      reservation_date: new Date('2026-08-20T00:00:00.000Z'),
      start_time: new Date('2026-08-20T20:00:00.000Z'),
      party_size: 4,
      checkin_token: 'tok',
    });
    mockedQr.mockResolvedValue('data:image/png;base64,xx');

    const state = baseState({
      webhookContext: {
        payloadId: undefined,
        message: { type: 'text', text: { body: 'sí, confirmo' } },
      } as never,
      workingConversationState: {
        metadata: { reservation_agent_active: true, reservation_draft: completeDraft },
      } as never,
    });

    const result = await reservationAgentNode(state);

    expect(mockedRunAgent).not.toHaveBeenCalled();
    expect(mockedCreate).toHaveBeenCalled();
    expect(result.handlerResult?.isInteractive).toBe(false);
    expect(String(result.handlerResult?.content)).toMatch(/Reserva confirmada/i);
  });

  it('confirmación tipable fulfilled false → cancela sin ReAct', async () => {
    const completeDraft = { ...draftReadyForEnv, environmentId: null };
    mockedFindFirst.mockResolvedValue({ metadata: { reservation_draft: completeDraft } });
    mockedExtractConfirm.mockResolvedValue({
      status: 'fulfilled',
      value: { confirmed: false },
      confidence: 0.9,
      source: 'llm',
      reason: null,
    });

    const state = baseState({
      webhookContext: {
        payloadId: undefined,
        message: { type: 'text', text: { body: 'mejor no' } },
      } as never,
      workingConversationState: {
        metadata: { reservation_agent_active: true, reservation_draft: completeDraft },
      } as never,
    });

    const result = await reservationAgentNode(state);

    expect(mockedRunAgent).not.toHaveBeenCalled();
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(clearReservationSessionAfterCancelMock).toHaveBeenCalledWith('conv-1');
    expect(String(result.handlerResult?.content)).toMatch(/cancelada/i);
  });

  it('horario en prosa fulfilled → persiste slot y muestra confirmación sin ReAct', async () => {
    const draftWaitingSlot = {
      date: '20/08/2026',
      partySize: 4,
    };
    const slotRow = {
      id: 'slot-19',
      start_time: '19:00',
      end_time: '20:30',
      is_active: true,
    };
    mockedEnvs.mockResolvedValue([]);
    mockedSlotsForDate.mockResolvedValue([slotRow]);
    mockedFindFirst.mockResolvedValue({ metadata: { reservation_draft: draftWaitingSlot } });
    mockedExtractSlot.mockResolvedValue({
      status: 'fulfilled',
      value: { slotId: 'slot-19' },
      confidence: 0.96,
      source: 'llm',
      reason: null,
    });

    const state = baseState({
      webhookContext: {
        payloadId: undefined,
        message: { type: 'text', text: { body: 'Si a las 19:00' } },
      } as never,
      workingConversationState: {
        metadata: { reservation_agent_active: true, reservation_draft: draftWaitingSlot },
      } as never,
    });

    const result = await reservationAgentNode(state);

    expect(mockedExtractSlot).toHaveBeenCalledWith(
      'Si a las 19:00',
      expect.arrayContaining([
        expect.objectContaining({ id: 'slot-19', startTime: '19:00', endTime: '20:30' }),
      ])
    );
    expect(mockedRunAgent).not.toHaveBeenCalled();
    expect(mockedPatch).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        reservation_draft: expect.objectContaining({
          slotId: 'slot-19',
          time: '19:00',
          endTime: '20:30',
        }),
      })
    );
    expect(result.handlerResult?.isInteractive).toBe(true);
  });

  it('sin partySize el paso es personas: no interpreta horario como slot tipable', async () => {
    const draftWaitingParty = { date: '20/08/2026' };
    mockedEnvs.mockResolvedValue([]);
    mockedFindFirst.mockResolvedValue({ metadata: { reservation_draft: draftWaitingParty } });
    mockedExtractParty.mockResolvedValue({
      status: 'fulfilled',
      value: { count: 6 },
      confidence: 0.95,
      source: 'llm',
      reason: null,
    });
    mockedRunAgent.mockResolvedValue({
      text: '🤖\n\n¿Para qué día?',
      signals: idleSignals,
    });

    const state = baseState({
      webhookContext: {
        payloadId: undefined,
        message: { type: 'text', text: { body: 'a las 19' } },
      } as never,
      workingConversationState: {
        metadata: { reservation_agent_active: true, reservation_draft: draftWaitingParty },
      } as never,
    });

    await reservationAgentNode(state);

    expect(mockedExtractSlot).not.toHaveBeenCalled();
    expect(mockedExtractParty).toHaveBeenCalled();
    expect(mockedPatch).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        reservation_draft: expect.objectContaining({ partySize: 6 }),
      })
    );
  });

  it('personas en prosa fulfilled → persiste y muestra confirmación sin ReAct', async () => {
    const draftWaitingParty = {
      date: '20/08/2026',
      slotId: 'slot-1',
      time: '20:00',
      endTime: '21:00',
    };
    mockedEnvs.mockResolvedValue([]);
    mockedFindFirst.mockResolvedValue({ metadata: { reservation_draft: draftWaitingParty } });
    mockedExtractParty.mockResolvedValue({
      status: 'fulfilled',
      value: { count: 4 },
      confidence: 0.99,
      source: 'llm',
      reason: null,
    });

    const state = baseState({
      webhookContext: {
        payloadId: undefined,
        message: { type: 'text', text: { body: '4' } },
      } as never,
      workingConversationState: {
        metadata: { reservation_agent_active: true, reservation_draft: draftWaitingParty },
      } as never,
    });

    const result = await reservationAgentNode(state);

    expect(mockedExtractParty).toHaveBeenCalledWith('4', 20);
    expect(mockedRunAgent).not.toHaveBeenCalled();
    expect(mockedPatch).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        reservation_draft: expect.objectContaining({ partySize: 4 }),
      })
    );
    expect(result.handlerResult?.isInteractive).toBe(true);
  });

  it('personas fulfilled sobre capacidad → aclara máximo sin persistir ni ReAct', async () => {
    const draftWaitingParty = {
      date: '20/08/2026',
      slotId: 'slot-1',
      time: '20:00',
      endTime: '21:00',
    };
    mockedEnvs.mockResolvedValue([]);
    mockedMaxParty.mockResolvedValue(6);
    mockedFindFirst.mockResolvedValue({ metadata: { reservation_draft: draftWaitingParty } });
    mockedExtractParty.mockResolvedValue({
      status: 'fulfilled',
      value: { count: 20 },
      confidence: 0.95,
      source: 'llm',
      reason: null,
    });

    const state = baseState({
      webhookContext: {
        payloadId: undefined,
        message: { type: 'text', text: { body: 'somos 20' } },
      } as never,
      workingConversationState: {
        metadata: { reservation_agent_active: true, reservation_draft: draftWaitingParty },
      } as never,
    });

    const result = await reservationAgentNode(state);

    expect(mockedRunAgent).not.toHaveBeenCalled();
    expect(mockedPatch).not.toHaveBeenCalled();
    expect(String(result.handlerResult?.content)).toMatch(/máximo es \*6\*/i);
  });

  it('personas fulfilled con ambientes → persiste y sigue al ReAct', async () => {
    const draftWaitingParty = {
      date: '20/08/2026',
      slotId: 'slot-1',
      time: '20:00',
      endTime: '21:00',
    };
    mockedEnvs.mockResolvedValue([salonPrincipal]);
    mockedFindFirst.mockResolvedValue({ metadata: { reservation_draft: draftWaitingParty } });
    mockedExtractParty.mockResolvedValue({
      status: 'fulfilled',
      value: { count: 4 },
      confidence: 0.98,
      source: 'llm',
      reason: null,
    });
    mockedRunAgent.mockResolvedValue({
      text: '🤖\n\n¿En qué ambiente preferís?',
      signals: idleSignals,
    });

    const state = baseState({
      webhookContext: {
        payloadId: undefined,
        message: { type: 'text', text: { body: 'somos 4' } },
      } as never,
      workingConversationState: {
        metadata: { reservation_agent_active: true, reservation_draft: draftWaitingParty },
      } as never,
    });

    await reservationAgentNode(state);

    expect(mockedPatch).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        reservation_draft: expect.objectContaining({ partySize: 4 }),
      })
    );
    expect(mockedRunAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ skipPendingExtraction: true })
    );
  });
});

describe('reservationAgentNode — comando de dominio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedEnvs.mockResolvedValue([]);
    mockedSlotsForDate.mockResolvedValue([]);
    mockedMaxParty.mockResolvedValue(20);
    clearReservationSessionAfterCancelMock.mockResolvedValue(undefined);
    buildCancelOrderMessageMock.mockResolvedValue('pedido wipe');
  });

  it('Cancelar pedido con sesión de reserva: wipe de pedido, no invoca al agente', async () => {
    const result = await reservationAgentNode(
      baseState({
        webhookContext: {
          payloadId: undefined,
          message: { text: { body: 'Cancelar pedido' } },
          to: '54911',
        } as never,
        customer: { id: 'cust-1', name: 'Ana', phone_number: '54911' } as never,
      })
    );

    expect(buildCancelOrderMessageMock).toHaveBeenCalled();
    expect(mockedRunAgent).not.toHaveBeenCalled();
    expect(result.handlerResult?.content).toBe('pedido wipe');
  });

  it('Cancelar reserva en texto: wipe de reserva, no invoca al agente', async () => {
    const result = await reservationAgentNode(
      baseState({
        webhookContext: {
          payloadId: undefined,
          message: { text: { body: 'Cancelar reserva' } },
        } as never,
      })
    );

    expect(clearReservationSessionAfterCancelMock).toHaveBeenCalledWith('conv-1');
    expect(mockedRunAgent).not.toHaveBeenCalled();
    expect(result.handlerResult?.content).toMatch(/Reserva cancelada/i);
  });
});

describe('reservationAgentNode — FAQ platos sin partySize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedEnvs.mockResolvedValue([]);
    mockedSlotsForDate.mockResolvedValue([]);
    mockedMaxParty.mockResolvedValue(20);
    mockedExtractConfirm.mockResolvedValue({ status: 'delegate' });
    mockedExtractEnv.mockResolvedValue({ status: 'delegate' });
    mockedExtractSlot.mockResolvedValue({ status: 'delegate' });
    mockedExtractParty.mockResolvedValue({ status: 'delegate' });
    mockedFindFirst.mockResolvedValue({
      metadata: { reservation_agent_active: true, reservation_draft: {} },
    });
    mockedRunAgent.mockResolvedValue({
      text: 'te paso al menú',
      signals: {
        ...idleSignals,
        delegateToMain: true,
        delegateToMainReason: 'sugerir platos para 1 por raciones',
      },
    });
  });

  it('sin Fact de personas: pide N y no delega al híbrido ni anexa resume', async () => {
    const result = await reservationAgentNode(
      baseState({
        webhookContext: {
          payloadId: undefined,
          message: { text: { body: 'Quiero saber que platos sirven para una reserva' } },
        } as never,
      })
    );

    expect(result.handlerResult?.content).toMatch(/¿Para cuántas personas\?/i);
    expect(result.handlerResult?.content).not.toMatch(/Seguimos con tu reserva/i);
    expect(result.handlerResult?.content).not.toMatch(/preferís cancelarla/i);
    expect(mockedPatch).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        pendingReservationDishFaq: expect.objectContaining({
          reason: 'sugerir platos para 1 por raciones',
          originalUserMessage: 'Quiero saber que platos sirven para una reserva',
        }),
      })
    );
    expect(mockedHybrid).not.toHaveBeenCalled();
  });
});

describe('reservationAgentNode — FAQ platos con Fact pendiente + N', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedEnvs.mockResolvedValue([]);
    mockedSlotsForDate.mockResolvedValue([]);
    mockedMaxParty.mockResolvedValue(20);
    mockedExtractConfirm.mockResolvedValue({ status: 'delegate' });
    mockedExtractEnv.mockResolvedValue({ status: 'delegate' });
    mockedExtractSlot.mockResolvedValue({ status: 'delegate' });
    mockedExtractParty.mockResolvedValue({
      status: 'fulfilled',
      value: { count: 6 },
      confidence: 1,
      source: 'llm',
      reason: null,
    });
    mockedFindFirst.mockResolvedValue({
      metadata: {
        reservation_agent_active: true,
        reservation_draft: {},
        pendingReservationDishFaq: {
          reason: 'sugerir platos para 6 por raciones',
          originalUserMessage: 'Quiero hacer una reserva Pero no sé que platillos',
          setAt: new Date().toISOString(),
        },
      },
    });
    mockedHybrid.mockResolvedValue({
      kind: 'response',
      handlerResult: { content: 'Para 6 van bien la parrillada y el pollo.', isInteractive: false },
    });
    mockedFindState.mockResolvedValue({
      metadata: { reservation_draft: { partySize: 6 } },
    });
  });

  it('Somos 6 + pending: delega FAQ al híbrido sin ReAct de fecha', async () => {
    const result = await reservationAgentNode(
      baseState({
        webhookContext: {
          payloadId: undefined,
          message: { type: 'text', text: { body: 'Somos 6' } },
        } as never,
        workingConversationState: {
          metadata: {
            reservation_agent_active: true,
            reservation_draft: {},
            pendingReservationDishFaq: {
              reason: 'sugerir platos para 6 por raciones',
              originalUserMessage: 'Quiero hacer una reserva Pero no sé que platillos',
              setAt: '2026-09-21T00:00:00.000Z',
            },
          },
        } as never,
      })
    );

    expect(mockedRunAgent).not.toHaveBeenCalled();
    expect(mockedHybrid).toHaveBeenCalled();
    expect(String(result.handlerResult?.content)).toMatch(/parrillada/i);
    expect(String(result.handlerResult?.content)).toMatch(/Seguimos con la reserva o preferís cancelarla/i);
    expect(String(result.handlerResult?.content)).not.toMatch(/para qué día/i);
    expect(String(result.handlerResult?.content)).not.toMatch(/Seguimos con tu reserva/i);
  });
});
