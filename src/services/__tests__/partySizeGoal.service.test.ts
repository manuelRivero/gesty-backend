/**
 * Tests del Goal blocking OBTENER_PERSONAS_DEL_PEDIDO
 * (PLAN-ACCION-PARTY-SIZE-GOAL).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../repositories', () => ({
  patchConversationMetadata: vi.fn(),
  omitConversationMetadataKeys: vi.fn(),
  findOrCreateConversationState: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  prisma: {
    conversation_state: {
      findUnique: vi.fn().mockResolvedValue({ metadata: {} }),
    },
  },
}));

import {
  blocksOrderPartySizeForReservationDomain,
  derivePartySizeGoal,
  derivePartySizeGoalCandidate,
  getPartySizeGoalLedger,
  isFoodRelatedPartySizeSignal,
  isPartySizeMissingForOrderingTools,
  mergePartySizeBlockedFood,
  partySizeRequiredPayload,
  buildPendingPartySizeOrderContextLines,
  rememberPartySizeBlockedFood,
  PARTY_SIZE_GOAL_TYPE,
  type PartySizeGoalLedger,
} from '../partySizeGoal.service';
import { deriveOrderCompletionGoal } from '../orderCompletionGoal.service';
import {
  deriveIntentCandidates,
  rankActiveIntent,
} from '../intent/activeIntent.service';
import {
  getGoalFulfillmentContractsForTool,
  getIntentCatalogEntry,
} from '../../domain/intent/family';
import { getRequestedPartySize } from '../productQuery/utils';
import { findOrCreateConversationState, patchConversationMetadata } from '../../repositories';

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

  it('cerrado en modo FAQ mid-reserva', () => {
    expect(
      derivePartySizeGoal(
        {
          partySize: null,
          foodRelatedSignal: true,
          checkoutActive: false,
          reservationDomainActive: true,
        },
        EMPTY_LEDGER
      ).open
    ).toBe(false);
  });

  it('sigue abierto con cola aunque todas las líneas traigan cantidad', () => {
    expect(
      derivePartySizeGoal(
        {
          partySize: null,
          foodRelatedSignal: true,
          checkoutActive: false,
        },
        EMPTY_LEDGER
      ).open
    ).toBe(true);
  });
});

describe('isPartySizeMissingForOrderingTools', () => {
  it('bloquea sin Fact de personas', () => {
    expect(isPartySizeMissingForOrderingTools({})).toBe(true);
  });

  it('permite con Fact presente', () => {
    expect(
      isPartySizeMissingForOrderingTools({ peopleCount: 2, requestedPartySize: 2 })
    ).toBe(false);
  });

  it('permite con abandonment', () => {
    expect(
      isPartySizeMissingForOrderingTools({
        intentLedger: { OBTENER_PERSONAS_DEL_PEDIDO: { abandonment: true } },
      })
    ).toBe(false);
  });

  it('permite en FAQ mid-reserva', () => {
    expect(
      isPartySizeMissingForOrderingTools({
        reservation_faq_delegation: { delegatedAt: new Date().toISOString() },
      })
    ).toBe(false);
  });

  it('permite con sesión de reserva activa', () => {
    expect(
      isPartySizeMissingForOrderingTools({ reservation_agent_active: true })
    ).toBe(false);
  });

  it('permite con pending switch a reserva', () => {
    expect(
      isPartySizeMissingForOrderingTools({
        pending_switch_to_reservation: {
          reason: 'reservar',
          askedAt: new Date().toISOString(),
        },
      })
    ).toBe(false);
  });
});

describe('blocksOrderPartySizeForReservationDomain', () => {
  it('true con agent active o FAQ o pending switch', () => {
    expect(blocksOrderPartySizeForReservationDomain({ reservation_agent_active: true })).toBe(
      true
    );
    expect(
      blocksOrderPartySizeForReservationDomain({
        reservation_faq_delegation: { delegatedAt: new Date().toISOString() },
      })
    ).toBe(true);
    expect(
      blocksOrderPartySizeForReservationDomain({
        pending_switch_to_reservation: {
          reason: 'x',
          askedAt: new Date().toISOString(),
        },
      })
    ).toBe(true);
  });

  it('false con solo draft (handback puede armar pedido)', () => {
    expect(
      blocksOrderPartySizeForReservationDomain({
        reservation_draft: { date: '21/09/2026', partySize: 4 },
      })
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

  it('declara fulfillment estructurado y cierra solo con party size válido', () => {
    const contract = getIntentCatalogEntry(PARTY_SIZE_GOAL_TYPE).fulfillment;
    expect(contract).toMatchObject({
      requiredFact: 'PERSONAS_DEL_PEDIDO',
      fulfillmentTool: 'save_party_size',
      expectedEffect: 'party_size_persisted',
    });
    expect(contract?.completionPredicate({ partySize: 3 })).toBe(true);
    expect(contract?.completionPredicate({ partySize: 0 })).toBe(false);
    expect(contract?.completionPredicate({ partySize: 100 })).toBe(false);
    expect(contract?.completionPredicate({ partySize: 1.5 })).toBe(false);
    expect(contract?.completionPredicate({ partySize: null })).toBe(false);
    expect(getGoalFulfillmentContractsForTool('save_party_size')).toEqual([
      expect.objectContaining({
        goalType: PARTY_SIZE_GOAL_TYPE,
        contract: expect.objectContaining({ expectedEffect: 'party_size_persisted' }),
      }),
    ]);
    expect(getGoalFulfillmentContractsForTool('search_products')).toEqual([]);
  });

  it('el lector de Fact acepta solo valores válidos según la definición canónica', () => {
    expect(getRequestedPartySize({ peopleCount: 3 })).toBe(3);
    expect(getRequestedPartySize({ requestedPartySize: 3 })).toBe(3);
    expect(getRequestedPartySize({ peopleCount: 100 })).toBeUndefined();
    expect(getRequestedPartySize({ peopleCount: 1.5 })).toBeUndefined();
  });

  it('publica el contrato en el candidato que consume el contexto', () => {
    const candidate = derivePartySizeGoalCandidate(
      { partySize: null, foodRelatedSignal: true, checkoutActive: false },
      { surfaceCount: 0 }
    );
    expect(candidate?.fulfillment?.fulfillmentTool).toBe('save_party_size');
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

describe('pedido en espera del número', () => {
  const parked = {
    source: 'lookup' as const,
    summary: 'ceviche',
    setAt: '2026-09-27T00:00:00.000Z',
  };

  it('suma búsquedas y deja que plan_order_lines las reemplace', () => {
    const two = mergePartySizeBlockedFood(parked, {
      source: 'lookup',
      summary: 'lomo',
    });
    expect(two?.summary).toBe('ceviche, lomo');
    expect(two?.source).toBe('lookup');

    const planned = mergePartySizeBlockedFood(two, {
      source: 'plan',
      summary: '1× ceviche, 1× lomo',
    });
    expect(planned?.source).toBe('plan');
    expect(planned?.summary).toBe('1× ceviche, 1× lomo');

    const lookupAfterPlan = mergePartySizeBlockedFood(planned, {
      source: 'lookup',
      summary: 'papa',
    });
    expect(lookupAfterPlan?.summary).toBe('1× ceviche, 1× lomo');
    expect(lookupAfterPlan?.source).toBe('plan');
  });

  it('un lookup de otro turno reemplaza al anterior y no se suma', () => {
    const previous = {
      ...parked,
      turnStartedAt: 'turn-1',
    };
    const next = mergePartySizeBlockedFood(previous, {
      source: 'lookup',
      summary: 'pizza',
      turnStartedAt: 'turn-2',
    });
    expect(next?.source).toBe('lookup');
    expect(next?.summary).toBe('pizza');
  });

  it('con personas ya guardadas la línea sigue trayendo el pedido', () => {
    const lines = buildPendingPartySizeOrderContextLines({
      peopleCount: 3,
      requestedPartySize: 3,
      pendingPartySizeOrder: { ...parked, summary: '1× ceviche' },
    });
    expect(lines.join('\n')).toMatch(/Pedido en espera \(personas ya guardadas\): 1× ceviche/);
    expect(lines.join('\n')).toMatch(/plan_order_lines/);
  });

  it('no duplica la misma búsqueda y no escribe vacío', () => {
    expect(
      mergePartySizeBlockedFood(parked, { source: 'lookup', summary: 'ceviche' })
    ).toBe(parked);
    expect(mergePartySizeBlockedFood(null, { source: 'lookup', summary: '   ' })).toBeNull();
  });

  it('la línea de estado nombra el pedido y el payload de la tool también', () => {
    const lines = buildPendingPartySizeOrderContextLines({
      pendingPartySizeOrder: parked,
    });
    expect(lines.join('\n')).toMatch(/Pedido en espera del número: ceviche/);
    expect(lines.join('\n')).toMatch(/save_party_size/);

    const payload = partySizeRequiredPayload('ceviche, lomo');
    expect('heldOrder' in payload && payload.heldOrder).toBe('ceviche, lomo');
    expect(payload.instruction).toMatch(/Pedido en espera: ceviche, lomo/);
    expect(partySizeRequiredPayload(null).instruction).not.toMatch(/Pedido en espera:/);
  });

  it('remember persiste el resumen fusionado releyendo la fila', async () => {
    vi.mocked(findOrCreateConversationState).mockResolvedValue({
      metadata: { pendingPartySizeOrder: parked },
    } as never);
    vi.mocked(patchConversationMetadata).mockResolvedValue({} as never);
    const summary = await rememberPartySizeBlockedFood('conv-1', {
      source: 'lookup',
      summary: 'lomo',
    });
    expect(summary).toBe('ceviche, lomo');
    expect(patchConversationMetadata).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        pendingPartySizeOrder: expect.objectContaining({
          source: 'lookup',
          summary: 'ceviche, lomo',
        }),
      })
    );
  });
});
