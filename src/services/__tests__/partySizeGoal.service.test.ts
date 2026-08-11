/**
 * Tests del Goal blocking OBTENER_PERSONAS_DEL_PEDIDO
 * (PLAN-ACCION-PARTY-SIZE-GOAL).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../repositories', () => ({
  patchConversationMetadata: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  prisma: {
    conversation_state: {
      findUnique: vi.fn().mockResolvedValue({ metadata: {} }),
    },
  },
}));

import {
  derivePartySizeGoal,
  derivePartySizeGoalCandidate,
  getPartySizeGoalLedger,
  isFoodRelatedPartySizeSignal,
  PARTY_SIZE_GOAL_TYPE,
  type PartySizeGoalLedger,
} from '../partySizeGoal.service';
import { deriveOrderCompletionGoal } from '../orderCompletionGoal.service';
import {
  deriveIntentCandidates,
  rankActiveIntent,
} from '../intent/activeIntent.service';
import { getIntentCatalogEntry } from '../../domain/intent/family';
import { patchConversationMetadata } from '../../repositories';

const EMPTY_LEDGER: PartySizeGoalLedger = {
  abandonment: false,
  surfaceCount: 0,
  lastSurfacedAt: null,
};

describe('derivePartySizeGoal', () => {
  it('abierto sin party + señal comida + sin checkout', () => {
    expect(
      derivePartySizeGoal(
        { partySize: null, foodRelatedSignal: true, checkoutActive: false },
        EMPTY_LEDGER
      ).open
    ).toBe(true);
  });

  it('cerrado con Fact presente', () => {
    expect(
      derivePartySizeGoal(
        { partySize: 3, foodRelatedSignal: true, checkoutActive: false },
        EMPTY_LEDGER
      ).open
    ).toBe(false);
  });

  it('cerrado sin señal de comida', () => {
    expect(
      derivePartySizeGoal(
        { partySize: null, foodRelatedSignal: false, checkoutActive: false },
        EMPTY_LEDGER
      ).open
    ).toBe(false);
  });

  it('cerrado con abandonment', () => {
    expect(
      derivePartySizeGoal(
        { partySize: null, foodRelatedSignal: true, checkoutActive: false },
        { ...EMPTY_LEDGER, abandonment: true }
      ).open
    ).toBe(false);
  });
});

describe('isFoodRelatedPartySizeSignal', () => {
  it('Fase A: intent NLP de comida', () => {
    expect(
      isFoodRelatedPartySizeSignal({
        detectionIntent: 'ORDER_FOOD',
        metadata: {},
      })
    ).toBe(true);
  });

  it('Fase B: shortlist pendiente aunque intent sea UNKNOWN', () => {
    expect(
      isFoodRelatedPartySizeSignal({
        detectionIntent: 'UNKNOWN',
        metadata: {
          pendingProductSelection: true,
          candidateProductIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
        },
      })
    ).toBe(true);
  });

  it('sin señal', () => {
    expect(
      isFoodRelatedPartySizeSignal({
        detectionIntent: 'GREETING',
        metadata: {},
      })
    ).toBe(false);
  });
});

describe('derivePartySizeGoalCandidate — presupuesto 3', () => {
  it('emite candidato Goal blocking', () => {
    const c = derivePartySizeGoalCandidate(
      { partySize: null, foodRelatedSignal: true, checkoutActive: false },
      { surfaceCount: 0 }
    );
    expect(c?.type).toBe(PARTY_SIZE_GOAL_TYPE);
    expect(c?.kind).toBe('goal');
    expect(c?.pressure).toBe('blocking');
  });

  it('enmudece al agotar maxSurfaces (3)', () => {
    const max = getIntentCatalogEntry(PARTY_SIZE_GOAL_TYPE).maxSurfaces;
    expect(
      derivePartySizeGoalCandidate(
        { partySize: null, foodRelatedSignal: true, checkoutActive: false },
        { surfaceCount: max }
      )
    ).toBeNull();
  });

  it('lee ledger legacy RECOLECTAR_PARTY_SIZE', () => {
    expect(
      getPartySizeGoalLedger({
        intentLedger: { RECOLECTAR_PARTY_SIZE: { surfaceCount: 2 } },
      }).surfaceCount
    ).toBe(2);
  });
});

describe('ranker: OBTENER_PERSONAS_DEL_PEDIDO gana a COMPLETAR_PEDIDO', () => {
  beforeEach(() => {
    vi.mocked(patchConversationMetadata).mockClear();
  });

  it('blocking party size es activo frente a completár pedido resumable', () => {
    const party = derivePartySizeGoalCandidate(
      { partySize: null, foodRelatedSignal: true, checkoutActive: false },
      { surfaceCount: 0 }
    );
    expect(party).not.toBeNull();

    const candidates = deriveIntentCandidates({
      order: {
        facts: { hasItems: true, checkoutActive: false },
        ledger: EMPTY_LEDGER,
      },
      reservation: {
        facts: { hasDraft: false, reservationAgentActive: false },
        ledger: EMPTY_LEDGER,
        hasEnvironments: false,
      },
      extras: [party!],
    });

    const ranked = rankActiveIntent(candidates, {
      COMPLETAR_PEDIDO: { surfaceCount: 0 },
      OBTENER_PERSONAS_DEL_PEDIDO: { surfaceCount: 0 },
    });

    expect(ranked.active?.type).toBe(PARTY_SIZE_GOAL_TYPE);
    expect(ranked.suppressed.some((s) => s.type === 'COMPLETAR_PEDIDO')).toBe(true);

    // Sanity: order completion seguiría abierto como Goal
    expect(
      deriveOrderCompletionGoal(
        { hasItems: true, checkoutActive: false },
        EMPTY_LEDGER
      ).open
    ).toBe(true);
  });
});
