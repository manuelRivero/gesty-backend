/**
 * Fase A: prosa → ReAct, cero clasificador de intent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/prisma', () => ({
  prisma: {
    menu_item: { findFirst: vi.fn() },
    draft_order: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('../../../../controllers/webhook/dispachers', () => ({
  dispatchInteractive: vi.fn(),
  dispatchIntent: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../../repositories', () => ({
  patchConversationMetadata: vi.fn().mockResolvedValue(undefined),
  omitConversationMetadataKeys: vi.fn().mockResolvedValue(undefined),
  findOrCreateConversationState: vi.fn(async () => ({ metadata: {} })),
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
  shouldAskIntentConfirmation: vi.fn(() => true),
}));

vi.mock('../../../../agents/reactAgent', () => ({
  runHybridReactAgent: vi.fn(),
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

vi.mock('../../../../services/intentAmbiguityConfirmation.service', () => ({
  buildIntentAmbiguityInteractiveMessage: vi.fn(),
}));

vi.mock('../../../../config/env', () => ({
  isReservationAgentEnabled: vi.fn(() => false),
  isCheckoutAgentEnabled: vi.fn(() => false),
}));

import { interactiveSubgraphNode, nlpSubgraphNode } from '../index';
import {
  detectIntentWithConfidence,
  shouldAskIntentConfirmation,
} from '../../../../services/ai/detection.service';
import { runHybridReactAgent } from '../../../../agents/reactAgent';
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

const nlpState = (message: string, metadata: Record<string, unknown> = {}): AgentState =>
  ({
    webhookContext: {
      message: { text: { body: message }, type: 'text' },
      to: '54911',
    },
    enrichedCtx: {
      conversationId: 'conv-1',
      conversationState: { metadata },
      conversation: { id: 'conv-1' },
      business: { id: 'biz-1' },
      customer: { phone_number: '54911' },
      message: { text: { body: message }, type: 'text' },
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

  it('no corre shouldAskIntentConfirmation ni setea awaitingIntentConfirmation', async () => {
    await nlpSubgraphNode(nlpState('hola'));

    expect(shouldAskIntentConfirmation).not.toHaveBeenCalled();
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
});
