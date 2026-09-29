/**
 * Fase A: prosa → ReAct, cero clasificador de intent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycleMock = vi.hoisted(() => ({
  state: {
    version: 1 as const,
    revision: 0,
    nextSequence: 1,
    processedMessageIds: [] as string[],
    records: [] as Array<Record<string, unknown>>,
  },
  metadata: {} as Record<string, unknown>,
}));

vi.mock('../../../../lib/prisma', () => ({
  prisma: {
    menu_item: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    draft_order: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('../../../../services/ai/openai.service', () => ({
  openai: {},
  detectIntent: vi.fn(),
  generateProductAwareResponse: vi.fn(),
}));

vi.mock('../../../../controllers/webhook/dispachers', () => ({
  dispatchInteractive: vi.fn(),
  dispatchIntent: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../../repositories', () => ({
  patchConversationMetadata: vi.fn().mockResolvedValue(undefined),
  omitConversationMetadataKeys: vi.fn().mockResolvedValue(undefined),
  findOrCreateConversationState: vi.fn(async () => ({ metadata: lifecycleMock.metadata })),
}));

vi.mock('../../../../agents/conversationHistory', () => ({
  buildAgentHistoryMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../../repositories/conversationState.repository', () => ({
  patchConversationMetadata: vi.fn().mockResolvedValue(undefined),
  omitConversationMetadataKeys: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../repositories/reservation.repository', () => ({
  findActiveEnvironmentsByBusinessId: vi.fn().mockResolvedValue([]),
  fetchReservationSlotsForBusinessDate: vi.fn(),
}));

vi.mock('../../../../agents/reservationAgent', () => ({
  runReservationAgent: vi.fn(),
}));

vi.mock('../../../../services/ai/detection.service', () => ({
  detectIntentWithConfidence: vi.fn(),
}));

vi.mock('../../../../agents/reactAgent', () => ({
  runHybridReactAgent: vi.fn(),
}));

vi.mock('../../../../services/humanIntentState.service', () => ({
  getHumanIntentState: vi.fn(async () => lifecycleMock.state),
  applyHumanIntentTurnDecision: vi.fn(async ({ messageId }: { messageId: string }) => {
    const nextState = {
      ...lifecycleMock.state,
      revision: lifecycleMock.state.revision + 1,
      processedMessageIds: [...lifecycleMock.state.processedMessageIds, messageId],
    };
    lifecycleMock.state = nextState;
    lifecycleMock.metadata = { ...lifecycleMock.metadata, humanIntentState: nextState };
    return { status: 'applied', state: nextState };
  }),
}));

vi.mock('../../../../services/humanIntentPreflight.service', () => ({
  runHumanIntentPreflight: vi.fn().mockResolvedValue({ decision: 'NO_INTENT' }),
}));

vi.mock('../../../../services/order.service', () => ({
  buildCancelOrderMessage: vi.fn().mockResolvedValue('pedido wipe'),
}));

vi.mock('../../../../services/cart.service', () => ({
  buildCartSummaryMessage: vi.fn().mockResolvedValue({
    type: 'list',
    header: { type: 'text', text: '🤖\n\n*Tu pedido actual* 🛒' },
    body: { text: '1× Papas a la huancaína' },
    footer: { text: 'Elegí o escribí' },
    action: { button: 'Ver opciones', sections: [] },
  }),
}));

vi.mock('../../../../services/reservationSessionReset.service', () => ({
  clearReservationSessionAfterCancel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../checkout', () => ({
  activateCheckoutSessionIfCartHasItems: vi.fn(),
  applyDefaultFulfillmentIfSingleOption: vi.fn(),
  resolveCheckoutAgentHandlerResult: vi.fn(),
}));

vi.mock('../../reservation', () => ({
  reservationAgentNode: vi.fn(),
}));

vi.mock('../../../../services/address.service', () => ({
  AddressService: class {
    startEdit = vi.fn().mockResolvedValue('Perfecto, decime la calle y número nuevamente.');
  },
}));

vi.mock('../../../../config/env', () => ({
  isReservationAgentEnabled: vi.fn(() => false),
  isCheckoutAgentEnabled: vi.fn(() => false),
}));

import { interactiveSubgraphNode, nlpSubgraphNode } from '../index';
import { detectIntentWithConfidence } from '../../../../services/ai/detection.service';
import { runHybridReactAgent } from '../../../../agents/reactAgent';
import { buildAgentHistoryMessages } from '../../../../agents/conversationHistory';
import {
  applyHumanIntentTurnDecision,
  getHumanIntentState,
} from '../../../../services/humanIntentState.service';
import { runHumanIntentPreflight } from '../../../../services/humanIntentPreflight.service';
import { prisma } from '../../../../lib/prisma';
import { dispatchIntent, dispatchInteractive } from '../../../../controllers/webhook/dispachers';
import { patchConversationMetadata } from '../../../../repositories';
import { patchConversationMetadata as patchConversationMetadataDirect } from '../../../../repositories/conversationState.repository';
import {
  activateCheckoutSessionIfCartHasItems,
  resolveCheckoutAgentHandlerResult,
} from '../../checkout';
import { reservationAgentNode } from '../../reservation';
import { isCheckoutAgentEnabled, isReservationAgentEnabled } from '../../../../config/env';
import { ConversationIntent } from '../../../../types/conversationIntent';
import type { AgentState } from '../../../state';
import { buildCancelOrderMessage } from '../../../../services/order.service';
import { clearReservationSessionAfterCancel } from '../../../../services/reservationSessionReset.service';
import { buildCartSummaryMessage } from '../../../../services/cart.service';

const nlpState = (message: string, metadata: Record<string, unknown> = {}): AgentState =>
  ({
    webhookContext: {
      message: { id: `wamid-${message}`, text: { body: message }, type: 'text' },
      to: '54911',
    },
    enrichedCtx: {
      conversationId: 'conv-1',
      conversationState: { metadata },
      conversation: { id: 'conv-1' },
      business: { id: 'biz-1' },
      customer: { id: 'cust-1', phone_number: '54911' },
      message: { id: `wamid-${message}`, text: { body: message }, type: 'text' },
      to: '54911',
    },
    conversation: { id: 'conv-1', lastReferencedProductId: null },
    customer: { id: 'cust-1', phone_number: '54911' },
    business: { id: 'biz-1' },
    conversationState: { metadata },
    workingConversationState: { metadata },
    hasAddress: true,
    isInCoverage: true,
    detectionContext: {},
    businessConfig: { delivery_enabled: true, takeaway_enabled: true },
  }) as unknown as AgentState;

describe('nlpSubgraphNode — agent-first', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycleMock.state = {
      version: 1,
      revision: 0,
      nextSequence: 1,
      processedMessageIds: [],
      records: [],
    };
    lifecycleMock.metadata = {};
    vi.mocked(isCheckoutAgentEnabled).mockReturnValue(false);
    vi.mocked(isReservationAgentEnabled).mockReturnValue(false);
    vi.mocked(runHybridReactAgent).mockResolvedValue({
      kind: 'response',
      handlerResult: { content: 'respuesta híbrida', isInteractive: false },
    } as never);
  });

  it.each(['ver menú', 'sacá la pizza', 'qué me recomendás'])(
    'prosa "%s": ReAct, cero detectIntentWithConfidence',
    async (message) => {
      const update = await nlpSubgraphNode(nlpState(message));

      expect(detectIntentWithConfidence).not.toHaveBeenCalled();
      expect(runHybridReactAgent).toHaveBeenCalled();
      expect(dispatchIntent).not.toHaveBeenCalled();
      expect(update.handlerResult?.content).toBe('respuesta híbrida');
      expect(update.dataCollectionDelegated).toBe(true);
      expect(update.detection?.intent).toBe(ConversationIntent.UNKNOWN);
    }
  );

  it('aplica NEW_INTENT antes de ReAct y pasa el estado actualizado al agente', async () => {
    const decision = {
      decision: 'NEW_INTENT' as const,
      intents: [{ goal: 'PEDIR' as const, request: { products: ['ceviche'] } }],
    };
    const active = {
      id: 'intent-ceviche',
      sequence: 1,
      goal: 'PEDIR',
      request: { products: ['ceviche'] },
      status: 'ACTIVE',
      blockers: [],
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z',
    };
    vi.mocked(runHumanIntentPreflight).mockResolvedValueOnce(decision);
    vi.mocked(applyHumanIntentTurnDecision).mockImplementationOnce(async ({ messageId }) => {
      const state = {
        ...lifecycleMock.state,
        revision: lifecycleMock.state.revision + 1,
        processedMessageIds: [messageId],
        records: [active],
      };
      lifecycleMock.state = state;
      lifecycleMock.metadata = { humanIntentState: state };
      return { status: 'applied', state };
    });

    const update = await nlpSubgraphNode(nlpState('Quiero ceviche'));

    expect(runHumanIntentPreflight.mock.invocationCallOrder[0]).toBeLessThan(
      applyHumanIntentTurnDecision.mock.invocationCallOrder[0]
    );
    expect(applyHumanIntentTurnDecision.mock.invocationCallOrder[0]).toBeLessThan(
      runHybridReactAgent.mock.invocationCallOrder[0]
    );
    const hybridContext = vi.mocked(runHybridReactAgent).mock.calls[0][0];
    expect(hybridContext.conversationState.metadata.humanIntentState.records).toEqual([active]);
    expect(update.handlerResult?.content).toBe('respuesta híbrida');
  });

  it('pasa a ReAct solo el fulfillmentCandidate devuelto por preflight', async () => {
    const activeIntent = {
      id: 'intent-order',
      sequence: 1,
      goal: 'PEDIR',
      request: { products: ['ceviche'] },
      status: 'ACTIVE',
      blockers: [],
    };
    lifecycleMock.state = {
      ...lifecycleMock.state,
      records: [activeIntent],
    };
    lifecycleMock.metadata = {
      lastOffer: { kind: 'ADD_ITEM' },
      humanIntentState: lifecycleMock.state,
    };
    vi.mocked(runHumanIntentPreflight).mockResolvedValueOnce({
      decision: 'CONTINUE_ACTIVE',
      intentId: activeIntent.id,
      answeredBlockerIds: [],
      fulfillmentCandidate: { goalType: 'OBTENER_PERSONAS_DEL_PEDIDO' },
    });

    await nlpSubgraphNode(nlpState('3', lifecycleMock.metadata));

    expect(runHybridReactAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        activeBlockingGoal: 'OBTENER_PERSONAS_DEL_PEDIDO',
        goalFulfillmentCandidate: { goalType: 'OBTENER_PERSONAS_DEL_PEDIDO' },
      })
    );
  });

  it('AMBIGUOUS no entra a ReAct ni al fallback legacy', async () => {
    vi.mocked(runHumanIntentPreflight).mockResolvedValueOnce({ decision: 'AMBIGUOUS' });

    const update = await nlpSubgraphNode(nlpState('¿Ese?'));

    expect(applyHumanIntentTurnDecision).not.toHaveBeenCalled();
    expect(runHybridReactAgent).not.toHaveBeenCalled();
    expect(dispatchIntent).not.toHaveBeenCalled();
    expect(update.handlerResult?.content).toMatch(/no me quedó claro/i);
  });

  it('party-size Goal activo deja que ReAct resuelva una respuesta aunque preflight falle cerrado', async () => {
    const activeOrder = {
      id: 'intent-order',
      sequence: 1,
      goal: 'PEDIR',
      request: {},
      status: 'ACTIVE',
      blockers: [],
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z',
    };
    lifecycleMock.state.records = [activeOrder];
    lifecycleMock.metadata = { humanIntentState: lifecycleMock.state };
    vi.mocked(runHumanIntentPreflight).mockResolvedValueOnce({ decision: 'AMBIGUOUS' });

    const update = await nlpSubgraphNode(nlpState('Para 3'));

    expect(runHumanIntentPreflight).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ activeBlockingGoal: 'OBTENER_PERSONAS_DEL_PEDIDO' }),
    }));
    expect(applyHumanIntentTurnDecision).not.toHaveBeenCalled();
    expect(runHybridReactAgent).toHaveBeenCalledOnce();
    expect(update.handlerResult?.content).toBe('respuesta híbrida');
    expect(lifecycleMock.state.records).toEqual([activeOrder]);
  });

  it.each([
    ['party size conocido', { peopleCount: 2, requestedPartySize: 2 }, true],
    ['sin pedido activo', {}, false],
  ])('no cede un AMBIGUOUS al Goal de party size cuando no está abierto (%s)', async (_caseName, metadata, withActiveOrder) => {
    if (withActiveOrder) {
      lifecycleMock.state.records = [{
        id: 'intent-order',
        sequence: 1,
        goal: 'PEDIR',
        request: { products: ['milanesa'] },
        status: 'ACTIVE',
        blockers: [],
        createdAt: '2026-09-28T00:00:00.000Z',
        updatedAt: '2026-09-28T00:00:00.000Z',
      }];
    }
    lifecycleMock.metadata = { ...metadata, humanIntentState: lifecycleMock.state };
    vi.mocked(runHumanIntentPreflight).mockResolvedValueOnce({ decision: 'AMBIGUOUS' });

    const update = await nlpSubgraphNode(nlpState('Para 3', metadata));

    expect(runHybridReactAgent).not.toHaveBeenCalled();
    expect(update.handlerResult?.content).toMatch(/no me quedó claro/i);
    expect(applyHumanIntentTurnDecision).not.toHaveBeenCalled();
  });

  it('solo pasa candidatos como referencias cuando el CTA consta como mostrado', async () => {
    const candidateId = '44444444-4444-4444-8444-444444444444';
    vi.mocked(prisma.menu_item.findMany).mockResolvedValueOnce([
      { id: candidateId, name: 'Ceviche' },
    ] as never);
    lifecycleMock.metadata = {
      pendingProductSelection: true,
      candidateProductIds: [candidateId],
    };
    await nlpSubgraphNode(nlpState('Dame ese.'));
    expect(vi.mocked(runHumanIntentPreflight).mock.calls[0][0].context.visibleReferences).toEqual([]);

    lifecycleMock.state = {
      version: 1,
      revision: 0,
      nextSequence: 1,
      processedMessageIds: [],
      records: [],
    };
    lifecycleMock.metadata = {
      lastCtaShownAt: '2026-09-27T00:00:00.000Z',
      pendingProductSelection: true,
      candidateProductIds: [candidateId],
    };
    vi.mocked(prisma.menu_item.findMany).mockResolvedValueOnce([
      { id: candidateId, name: 'Ceviche' },
    ] as never);
    await nlpSubgraphNode(nlpState('Dame ese.'));
    expect(vi.mocked(runHumanIntentPreflight).mock.calls[1][0].context.visibleReferences)
      .toEqual([{ id: candidateId, kind: 'product', label: 'Ceviche' }]);
  });

  it('"Hola buenas" acepta NO_INTENT sin mutar HumanIntentState y continúa a ReAct', async () => {
    const originalState = structuredClone(lifecycleMock.state);
    const originalMetadata = structuredClone(lifecycleMock.metadata);

    const update = await nlpSubgraphNode(nlpState('Hola buenas'));

    expect(runHumanIntentPreflight).toHaveBeenCalledWith(expect.objectContaining({
      turn: expect.objectContaining({ text: 'Hola buenas' }),
    }));
    expect(applyHumanIntentTurnDecision).not.toHaveBeenCalled();
    expect(lifecycleMock.state).toEqual(originalState);
    expect(lifecycleMock.metadata).toEqual(originalMetadata);
    expect(runHybridReactAgent).toHaveBeenCalledOnce();
    expect(update.handlerResult?.content).toBe('respuesta híbrida');
  });

  it('emite hitos INFO correlacionados por turnId sin logs de infraestructura', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const state = nlpState('Hola buenas');
    (state.webhookContext as { turnId?: string }).turnId = 'turn-1234';
    (state.enrichedCtx as { turnId?: string }).turnId = 'turn-1234';

    try {
      await nlpSubgraphNode(state);
      const output = info.mock.calls.flat().filter((value) => typeof value === 'string').join('\n');

      for (const event of ['[turn]', '[preflight]', '[intent]', '[react]', '[response]']) {
        expect(output).toContain(`"event":"${event}"`);
      }
      expect(output).toContain('"turnId":"turn-1234"');
      expect(output).not.toMatch(/WhatsAppTyping|adminSocket|status event/);
    } finally {
      info.mockRestore();
    }
  });

  it('no plantea confirmación de intent: el híbrido desambigua en prosa', async () => {
    await nlpSubgraphNode(nlpState('hola'));

    // El menú "¿quisiste decir X o Y?" ya no existe como mecanismo (V-10):
    // ni la señal en metadata ni el builder del mensaje.
    expect(patchConversationMetadata).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ awaitingIntentConfirmation: true })
    );
  });

  it('quiero pagar + señal start_checkout_session abre checkout sin intent CHECKOUT', async () => {
    vi.mocked(isCheckoutAgentEnabled).mockReturnValue(true);
    vi.mocked(runHybridReactAgent).mockResolvedValue({
      kind: 'delegate_checkout',
      reason: 'quiere pagar',
    } as never);
    vi.mocked(activateCheckoutSessionIfCartHasItems).mockResolvedValue(null);
    vi.mocked(resolveCheckoutAgentHandlerResult).mockResolvedValue({
      content: '¿Cómo lo recibís?',
      isInteractive: true,
    });

    const update = await nlpSubgraphNode(nlpState('quiero pagar'));

    expect(detectIntentWithConfidence).not.toHaveBeenCalled();
    expect(update.detection?.intent).not.toBe(ConversationIntent.CHECKOUT);
    expect(activateCheckoutSessionIfCartHasItems).toHaveBeenCalled();
    expect(resolveCheckoutAgentHandlerResult).toHaveBeenCalled();
    expect(update.handlerResult?.content).toMatch(/recibís/i);
  });

  it('carrito vacío + empty_cart no prende checkout_active', async () => {
    vi.mocked(isCheckoutAgentEnabled).mockReturnValue(true);
    vi.mocked(runHybridReactAgent).mockResolvedValue({
      kind: 'delegate_checkout',
      reason: 'quiere pagar',
    } as never);
    vi.mocked(activateCheckoutSessionIfCartHasItems).mockResolvedValue({
      content: 'Tu carrito está vacío',
      isInteractive: false,
    });

    const update = await nlpSubgraphNode(nlpState('quiero pagar'));

    expect(resolveCheckoutAgentHandlerResult).not.toHaveBeenCalled();
    expect(patchConversationMetadata).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ checkout_active: true })
    );
    expect(update.handlerResult?.content).toMatch(/vacío/i);
  });

  it('quiero reservar + señal start_reservation_session abre la sesión de reservas en el mismo turno', async () => {
    vi.mocked(isReservationAgentEnabled).mockReturnValue(true);
    vi.mocked(runHybridReactAgent).mockResolvedValue({
      kind: 'delegate_reservation',
      reason: 'quiere reservar una mesa',
    } as never);
    vi.mocked(reservationAgentNode).mockResolvedValue({
      handlerResult: { content: '¿Para qué día querés reservar?', isInteractive: false },
      dataCollectionDelegated: true,
    });

    const update = await nlpSubgraphNode(nlpState('quiero reservar una mesa'));

    expect(detectIntentWithConfidence).not.toHaveBeenCalled();
    expect(reservationAgentNode).toHaveBeenCalledOnce();
    expect(dispatchIntent).not.toHaveBeenCalled();
    expect(update.handlerResult?.content).toMatch(/qué día/i);
    expect(update.dataCollectionDelegated).toBe(true);
  });

  it('delegate_reservation con el agente de reservas apagado no invoca el nodo', async () => {
    vi.mocked(isReservationAgentEnabled).mockReturnValue(false);
    vi.mocked(runHybridReactAgent).mockResolvedValue({
      kind: 'delegate_reservation',
      reason: 'quiere reservar',
    } as never);

    await nlpSubgraphNode(nlpState('quiero reservar'));

    expect(reservationAgentNode).not.toHaveBeenCalled();
    expect(dispatchIntent).toHaveBeenCalled();
  });

  it('recupera el carrito persistido si ReAct falla después de escribir y evita UNKNOWN fallback', async () => {
    vi.mocked(runHybridReactAgent).mockRejectedValue(new Error('post-tool model failure'));
    vi.mocked(prisma.draft_order.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'draft-1',
        draft_order_item: [
          { id: 'line-1', product_id: 'papa-1', quantity: 1, variation: null, notes: null },
        ],
      } as never);

    const update = await nlpSubgraphNode(nlpState('un ceviche y unas papas'));

    expect(dispatchIntent).not.toHaveBeenCalled();
    expect(buildCartSummaryMessage).toHaveBeenCalledWith(
      expect.objectContaining({ llmProse: null })
    );
    expect(update.handlerResult?.isInteractive).toBe(true);
    expect(update.handlerResult?.content).toMatchObject({
      body: { text: expect.stringContaining('1× Papas') },
    });
  });

  it('recupera desde draft_order si ReAct termina null tras una mutación y evita UNKNOWN fallback', async () => {
    vi.mocked(runHybridReactAgent).mockResolvedValue(null);
    vi.mocked(prisma.draft_order.findFirst)
      .mockResolvedValueOnce({
        id: 'draft-1',
        draft_order_item: [],
      } as never)
      .mockResolvedValueOnce({
        id: 'draft-1',
        draft_order_item: [
          { id: 'line-1', product_id: 'papa-1', quantity: 3, variation: null, notes: null },
        ],
      } as never);
    vi.mocked(buildCartSummaryMessage).mockResolvedValueOnce({
      type: 'list',
      header: { type: 'text', text: '🤖\n\n*Tu pedido actual* 🛒' },
      body: { text: '3× Papa' },
      footer: { text: 'Elegí o escribí' },
      action: { button: 'Ver opciones', sections: [] },
    } as never);

    const update = await nlpSubgraphNode(nlpState('Y ahora ?'));

    expect(dispatchIntent).not.toHaveBeenCalled();
    expect(buildCartSummaryMessage).toHaveBeenCalledWith(
      expect.objectContaining({ llmProse: null })
    );
    expect(update.handlerResult?.content).toMatchObject({
      body: { text: '3× Papa' },
    });
  });

  it('cambiar dirección + señal start_address_edit_session abre onboarding (mismo efecto que EDIT_ADDRESS)', async () => {
    vi.mocked(runHybridReactAgent).mockResolvedValue({
      kind: 'delegate_address_edit',
      reason: 'quiere cambiar la dirección',
    } as never);

    const update = await nlpSubgraphNode(
      nlpState('Perfecto quiero cambiar mi dirección de entrega')
    );

    expect(detectIntentWithConfidence).not.toHaveBeenCalled();
    expect(patchConversationMetadataDirect).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ onboarding_agent_active: true })
    );
    expect(dispatchIntent).not.toHaveBeenCalled();
    expect(update.handlerResult?.content).toMatch(/calle y número/i);
    expect(update.dataCollectionDelegated).toBe(true);
  });
});

describe('interactiveSubgraphNode — botones', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dispatchInteractive).mockResolvedValue({
      content: 'agregado',
      isInteractive: false,
    });
    vi.mocked(runHybridReactAgent).mockResolvedValue({
      kind: 'response',
      handlerResult: { content: '¿Para cuántas personas?', isInteractive: false },
    } as never);
  });

  it('ADD_ITEM: va al mapper, no al ReAct', async () => {
    const state = {
      webhookContext: { payloadId: 'ADD_ITEM:11111111-1111-1111-1111-111111111111' },
      enrichedCtx: {
        payloadId: 'ADD_ITEM:11111111-1111-1111-1111-111111111111',
        conversationState: { metadata: {} },
      },
      conversation: { id: 'conv-1' },
      business: { id: 'biz-1' },
      businessClosedButOperating: false,
    } as unknown as AgentState;

    const result = await interactiveSubgraphNode(state);

    expect(dispatchInteractive).toHaveBeenCalled();
    expect(runHybridReactAgent).not.toHaveBeenCalled();
    expect(result.handlerResult?.content).toBe('agregado');
  });

  it('ORDER_FOOD: no va a dispatchInteractive; corre NLP/híbrido con texto fresco', async () => {
    const state = {
      webhookContext: {
        payloadId: 'ORDER_FOOD',
        message: { id: 'wamid-order-food', type: 'interactive', interactive: {} },
      },
      enrichedCtx: {
        payloadId: 'ORDER_FOOD',
        conversationState: { metadata: {} },
        conversation: { id: 'conv-1' },
        business: { id: 'biz-1' },
        customer: { phone_number: '54911' },
        message: { id: 'wamid-order-food', type: 'interactive', interactive: {} },
        to: '54911',
      },
      conversation: { id: 'conv-1', lastReferencedProductId: null },
      customer: { id: 'cust-1', phone_number: '54911' },
      business: { id: 'biz-1' },
      conversationState: { metadata: {} },
      workingConversationState: { metadata: {} },
      hasAddress: true,
      isInCoverage: true,
      detectionContext: {},
      businessConfig: { delivery_enabled: true, takeaway_enabled: true },
      businessClosedButOperating: false,
    } as unknown as AgentState;

    const result = await interactiveSubgraphNode(state);

    expect(dispatchInteractive).not.toHaveBeenCalled();
    expect(runHybridReactAgent).toHaveBeenCalled();
    const hybridCtx = vi.mocked(runHybridReactAgent).mock.calls[0]?.[0] as {
      payloadId?: string | null;
      message?: { text?: { body?: string }; type?: string };
    };
    expect(hybridCtx.payloadId).toBeUndefined();
    expect(hybridCtx.message?.text?.body).toMatch(/quiero hacer un pedido/i);
    expect(result.handlerResult?.content).toBe('¿Para cuántas personas?');
  });
});

describe('nlpSubgraphNode — comando de dominio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isCheckoutAgentEnabled).mockReturnValue(false);
    vi.mocked(isReservationAgentEnabled).mockReturnValue(false);
    vi.mocked(buildCancelOrderMessage).mockResolvedValue('pedido wipe');
    vi.mocked(clearReservationSessionAfterCancel).mockResolvedValue(undefined);
  });

  it('Cancelar reserva: wipe de reserva, no pasa por el híbrido', async () => {
    const result = await nlpSubgraphNode(nlpState('Cancelar reserva'));
    expect(clearReservationSessionAfterCancel).toHaveBeenCalledWith('conv-1');
    expect(runHybridReactAgent).not.toHaveBeenCalled();
    expect(result.handlerResult?.content).toMatch(/Reserva cancelada/i);
  });

  it('Cancelar pedido: wipe de pedido, no pasa por el híbrido', async () => {
    const result = await nlpSubgraphNode(nlpState('Cancelar pedido'));
    expect(buildCancelOrderMessage).toHaveBeenCalled();
    expect(runHybridReactAgent).not.toHaveBeenCalled();
    expect(result.handlerResult?.content).toBe('pedido wipe');
  });
});
