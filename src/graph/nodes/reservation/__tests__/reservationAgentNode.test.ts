/**
 * Tests de `reservationAgentNode` (P0.3):
 *  - R-A/R-B: un payload `RESERVATION_SLOT:x` mergea sobre el draft
 *    existente sin perder `date`/`partySize` ya cargados, y el mismo turno
 *    ya ve el slot (lectura fresca, no snapshot local).
 *  - D4: la tarjeta de confirmación sale aunque el LLM no haya llamado
 *    `present_confirmation`, si el paso derivado es `confirm` y el draft
 *    está completo.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../lib/prisma', () => ({
  prisma: {
    conversation_state: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    environment: { findUnique: vi.fn() },
  },
}));

vi.mock('../../../../repositories/conversationState.repository', () => ({
  omitConversationMetadataKeys: vi.fn(),
  patchConversationMetadata: vi.fn(),
}));

vi.mock('../../../../repositories/reservation.repository', () => ({
  fetchReservationSlotsForBusinessDate: vi.fn(),
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
}));

vi.mock('../../../../services/reservationCompletionGoal.service', () => ({
  getReservationCompletionLedger: vi.fn().mockReturnValue({
    abandonment: false,
    surfaceCount: 0,
    lastSurfacedAt: null,
  }),
  reviveReservationCompletionIfAbandoned: vi.fn(),
}));

vi.mock('../../../../config/env', () => ({
  isHybridAgentMode: vi.fn().mockReturnValue(false),
}));

// Cortar la cadena de imports pesada del agente principal (reactAgent →
// tools/index → menu.service → openai.service) que instancia un cliente
// OpenAI en el import y rompe el test sin OPENAI_API_KEY.
vi.mock('../../../../agents/reactAgent', () => ({
  runHybridReactAgent: vi.fn(),
}));
vi.mock('../../../../services/ai/detection.service', () => ({
  detectIntentWithConfidence: vi.fn(),
}));
vi.mock('../../../../repositories', () => ({
  findOrCreateConversationState: vi.fn(),
}));

import { prisma } from '../../../../lib/prisma';
import {
  patchConversationMetadata,
  omitConversationMetadataKeys,
} from '../../../../repositories/conversationState.repository';
import { fetchActiveReservationSlotById } from '../../../../repositories/reservation.repository';
import { runReservationAgent } from '../../../../agents/reservationAgent';
import { reservationAgentNode } from '../index';
import type { AgentState } from '../../../state';

const mockedFindFirst = prisma.conversation_state.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedPatch = patchConversationMetadata as unknown as ReturnType<typeof vi.fn>;
const mockedSlot = fetchActiveReservationSlotById as unknown as ReturnType<typeof vi.fn>;
const mockedRunAgent = runReservationAgent as unknown as ReturnType<typeof vi.fn>;

const EXISTING_DRAFT = { date: '20/08/2026', partySize: 4 };

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
    mockedRunAgent.mockResolvedValue({
      text: '🤖\n\nListo',
      signals: {
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
      },
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
});

describe('reservationAgentNode — tarjeta de confirmación por estado (D4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        presentSlots: false,
        presentSlotsDate: null,
        presentEnvironments: false,
        presentConfirmation: false, // el LLM no llamó la señal
        confirmReservationResolved: null,
        delegateToMain: false,
        delegateToMainReason: null,
        handbackReservation: false,
        handbackReservationReason: null,
        abandonReservation: false,
        abandonReservationReason: null,
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
