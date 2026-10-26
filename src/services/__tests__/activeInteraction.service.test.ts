import { beforeEach, describe, expect, it, vi } from 'vitest';

const conversationMetadata = { current: {} as Record<string, unknown> };

vi.mock('../../repositories', () => ({
  mutateConversationMetadata: async (
    _conversationId: string,
    mutate: (current: Record<string, unknown>) => {
      metadata: Record<string, unknown> | null;
      result: unknown;
    }
  ) => {
    const mutation = mutate(conversationMetadata.current);
    if (mutation.metadata) conversationMetadata.current = mutation.metadata;
    return mutation.result;
  },
}));

import {
  evaluateIncomingInteraction,
  isGenericGatedPayloadId,
  registerActiveInteraction,
  ACTIVE_INTERACTION_METADATA_KEY,
  type ActiveInteraction,
} from '../activeInteraction.service';

const CONVERSATION_ID = 'conv-1';

describe('activeInteraction.service', () => {
  beforeEach(() => {
    conversationMetadata.current = {};
  });

  describe('isGenericGatedPayloadId', () => {
    it('no gatea navegación global ni payloads gobernados por ProductResolution', () => {
      expect(isGenericGatedPayloadId('VIEW_MENU')).toBe(false);
      expect(isGenericGatedPayloadId('VIEW_CART')).toBe(false);
      expect(isGenericGatedPayloadId('ADD_ITEM:prod-1:2')).toBe(false);
      expect(isGenericGatedPayloadId('SELECT_PRODUCT:prod-1')).toBe(false);
      expect(isGenericGatedPayloadId('SELECT_ORDER_PRODUCT:prod-1')).toBe(false);
    });

    it('gatea el resto (reservas, categorías, confirmaciones puntuales)', () => {
      expect(isGenericGatedPayloadId('RESERVATION_SLOT:slot-1')).toBe(true);
      expect(isGenericGatedPayloadId('CATEGORY:cat-1')).toBe(true);
      expect(isGenericGatedPayloadId('CONFIRM_INTENT:ORDER')).toBe(true);
      expect(isGenericGatedPayloadId('INCREASE_ITEM:item-1')).toBe(true);
    });
  });

  describe('registerActiveInteraction', () => {
    it('registra solo los ids gateados de la última interacción, descartando nav/producto', async () => {
      await registerActiveInteraction(
        CONVERSATION_ID,
        ['RESERVATION_SLOT:slot-1', 'RESERVATION_SLOT:slot-2', 'VIEW_MENU', 'ADD_ITEM:x:1'],
        'turn-1'
      );
      const stored = conversationMetadata.current[ACTIVE_INTERACTION_METADATA_KEY] as ActiveInteraction;
      expect(stored.validOptionIds).toEqual(['RESERVATION_SLOT:slot-1', 'RESERVATION_SLOT:slot-2']);
      expect(stored.turnId).toBe('turn-1');
      expect(stored.consumedOptionId).toBeNull();
    });

    it('una nueva interacción reemplaza por completo a la anterior', async () => {
      await registerActiveInteraction(CONVERSATION_ID, ['RESERVATION_SLOT:slot-1'], 'turn-1');
      const first = conversationMetadata.current[ACTIVE_INTERACTION_METADATA_KEY] as ActiveInteraction;

      await registerActiveInteraction(CONVERSATION_ID, ['CATEGORY:bebidas'], 'turn-2');
      const second = conversationMetadata.current[ACTIVE_INTERACTION_METADATA_KEY] as ActiveInteraction;

      expect(second.id).not.toBe(first.id);
      expect(second.validOptionIds).toEqual(['CATEGORY:bebidas']);
    });

    it('un mensaje interactivo que solo trae ids de navegación deja sin interacción activa (sin bloquear nada)', async () => {
      await registerActiveInteraction(CONVERSATION_ID, ['RESERVATION_SLOT:slot-1'], 'turn-1');
      await registerActiveInteraction(CONVERSATION_ID, ['VIEW_MENU', 'VIEW_CART'], 'turn-2');
      expect(conversationMetadata.current[ACTIVE_INTERACTION_METADATA_KEY]).toBeNull();
    });

    it('no toca el resto de metadata.conversation_state (carrito, reserva, etc.)', async () => {
      conversationMetadata.current = { reservation: { step: 'ASK_SLOT' }, draftOrderId: 'order-1' };
      await registerActiveInteraction(CONVERSATION_ID, ['RESERVATION_SLOT:slot-1'], 'turn-1');
      expect(conversationMetadata.current.reservation).toEqual({ step: 'ASK_SLOT' });
      expect(conversationMetadata.current.draftOrderId).toBe('order-1');
    });
  });

  describe('evaluateIncomingInteraction', () => {
    it('"none": sin interacción activa, no hay nada que validar', async () => {
      const outcome = await evaluateIncomingInteraction(CONVERSATION_ID, {
        isInteractivePayload: true,
        payloadId: 'RESERVATION_SLOT:slot-1',
      });
      expect(outcome).toBe('none');
    });

    it('"valid": una selección vigente se consume y puede despacharse', async () => {
      await registerActiveInteraction(CONVERSATION_ID, ['RESERVATION_SLOT:slot-1', 'RESERVATION_SLOT:slot-2'], 't1');

      const outcome = await evaluateIncomingInteraction(CONVERSATION_ID, {
        isInteractivePayload: true,
        payloadId: 'RESERVATION_SLOT:slot-1',
      });

      expect(outcome).toBe('valid');
      const stored = conversationMetadata.current[ACTIVE_INTERACTION_METADATA_KEY] as ActiveInteraction;
      expect(stored.consumedOptionId).toBe('RESERVATION_SLOT:slot-1');
    });

    it('"stale": una selección antigua (no vigente) se rechaza sin tocar carrito/reserva', async () => {
      conversationMetadata.current = {
        reservation: { step: 'ASK_SLOT', date: '2026-10-27' },
        draftOrderId: 'order-1',
      };
      await registerActiveInteraction(CONVERSATION_ID, ['RESERVATION_SLOT:slot-new'], 't2');

      const outcome = await evaluateIncomingInteraction(CONVERSATION_ID, {
        isInteractivePayload: true,
        payloadId: 'RESERVATION_SLOT:slot-old',
      });

      expect(outcome).toBe('stale');
      // El carrito/reserva de dominio queda intacto: solo se tocó activeInteraction.
      expect(conversationMetadata.current.reservation).toEqual({ step: 'ASK_SLOT', date: '2026-10-27' });
      expect(conversationMetadata.current.draftOrderId).toBe('order-1');
    });

    it('"stale": dos selecciones de la misma interacción no producen efectos duplicados (segundo click ya consumido)', async () => {
      await registerActiveInteraction(CONVERSATION_ID, ['RESERVATION_SLOT:slot-1'], 't1');

      const first = await evaluateIncomingInteraction(CONVERSATION_ID, {
        isInteractivePayload: true,
        payloadId: 'RESERVATION_SLOT:slot-1',
      });
      const second = await evaluateIncomingInteraction(CONVERSATION_ID, {
        isInteractivePayload: true,
        payloadId: 'RESERVATION_SLOT:slot-1',
      });

      expect(first).toBe('valid');
      expect(second).toBe('stale');
    });

    it('"invalidated": un mensaje de texto nuevo invalida la interacción anterior', async () => {
      await registerActiveInteraction(CONVERSATION_ID, ['RESERVATION_SLOT:slot-1'], 't1');

      const outcome = await evaluateIncomingInteraction(CONVERSATION_ID, {
        isInteractivePayload: false,
        payloadId: null,
      });

      expect(outcome).toBe('invalidated');
      expect(conversationMetadata.current[ACTIVE_INTERACTION_METADATA_KEY]).toBeNull();
    });

    it('"bypass": un click de navegación global o de un payload gobernado por ProductResolution no toca activeInteraction', async () => {
      await registerActiveInteraction(CONVERSATION_ID, ['RESERVATION_SLOT:slot-1'], 't1');

      const outcome = await evaluateIncomingInteraction(CONVERSATION_ID, {
        isInteractivePayload: true,
        payloadId: 'ADD_ITEM:prod-1:1',
      });

      expect(outcome).toBe('bypass');
      // La interacción activa (ajena a este click) sigue intacta — la
      // validación de dominio de ADD_ITEM (ProductResolution, carrito) corre
      // después, sin interferencia de este mecanismo.
      const stored = conversationMetadata.current[ACTIVE_INTERACTION_METADATA_KEY] as ActiveInteraction;
      expect(stored.validOptionIds).toEqual(['RESERVATION_SLOT:slot-1']);
      expect(stored.consumedOptionId).toBeNull();
    });
  });
});
