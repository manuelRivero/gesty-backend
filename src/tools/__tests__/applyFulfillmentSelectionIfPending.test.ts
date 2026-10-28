/**
 * Ciclo de vida completo de la solicitud de fulfillment pendiente
 * (`markFulfillmentPending` + `applyFulfillmentSelectionIfPending`):
 * un click de `FULFILLMENT_DELIVERY`/`FULFILLMENT_TAKE_AWAY` solo tiene
 * autoridad mientras exista una solicitud vigente, vinculada al draft activo
 * en el momento de presentar el botón. Ver AUDITORIA-REPLY-BUTTONS-VIGENCIA.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeDraft {
  id: string;
  fulfillment_type: string | null;
}

let draft: FakeDraft | null = null;
let metadataStore: Record<string, unknown> = {};

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: {
      findFirst: vi.fn(async () => (draft ? { ...draft } : null)),
    },
    $executeRaw: vi.fn(
      async (_strings: unknown, type: string, draftId: string): Promise<number> => {
        if (draft && draft.id === draftId && draft.fulfillment_type === null) {
          draft.fulfillment_type = type;
          return 1;
        }
        return 0;
      }
    ),
  },
}));

vi.mock('../../repositories/conversationState.repository', () => ({
  patchConversationMetadata: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
    metadataStore = { ...metadataStore, ...patch };
  }),
  mutateConversationMetadata: vi.fn(
    async <T>(
      _id: string,
      mutate: (current: Record<string, unknown>) => { metadata: Record<string, unknown> | null; result: T }
    ): Promise<T> => {
      const { metadata, result } = mutate(metadataStore);
      if (metadata) metadataStore = metadata;
      return result;
    }
  ),
}));

import { applyFulfillmentSelectionIfPending, markFulfillmentPending } from '../checkout';
import { prisma } from '../../lib/prisma';

const BUSINESS_ID = 'biz-1';
const PHONE = '+5491100000000';
const CONVERSATION_ID = 'conv-1';

describe('ciclo de vida de pending_fulfillment_action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metadataStore = {};
    draft = { id: 'draft-1', fulfillment_type: null };
  });

  it('1) selección vigente: presentar + click aplica la selección', async () => {
    await markFulfillmentPending(BUSINESS_ID, PHONE, CONVERSATION_ID);

    const result = await applyFulfillmentSelectionIfPending(
      BUSINESS_ID,
      PHONE,
      CONVERSATION_ID,
      'DELIVERY'
    );

    expect(result.applied).toBe(true);
    expect(draft?.fulfillment_type).toBe('DELIVERY');
    expect(metadataStore.pending_fulfillment_action).toBeUndefined();
  });

  it('2) texto intermedio que invalida sin resolver fulfillment: botón viejo rechazado sin mutar', async () => {
    await markFulfillmentPending(BUSINESS_ID, PHONE, CONVERSATION_ID);

    // Equivalente a `clearCheckoutSession` tras handback/cancel: la solicitud
    // se invalida sin que fulfillment_type se haya resuelto.
    delete metadataStore.pending_fulfillment_action;

    const result = await applyFulfillmentSelectionIfPending(
      BUSINESS_ID,
      PHONE,
      CONVERSATION_ID,
      'DELIVERY'
    );

    expect(result.applied).toBe(false);
    expect(result.error).toBe('no_pending');
    expect(draft?.fulfillment_type).toBeNull();
  });

  it('3) nuevo conjunto de botones reemplaza al anterior: el viejo no aplica, el nuevo sí', async () => {
    await markFulfillmentPending(BUSINESS_ID, PHONE, CONVERSATION_ID);
    const oldPending = metadataStore.pending_fulfillment_action;

    // El draft viejo se reemplaza por uno nuevo (ej. se canceló y se armó
    // otro carrito) sin que nadie haya vuelto a presentar los botones todavía.
    draft = { id: 'draft-2', fulfillment_type: null };

    const staleClick = await applyFulfillmentSelectionIfPending(
      BUSINESS_ID,
      PHONE,
      CONVERSATION_ID,
      'DELIVERY'
    );
    expect(staleClick.applied).toBe(false);
    expect(staleClick.error).toBe('wrong_draft');
    expect(draft?.fulfillment_type).toBeNull();
    // La solicitud vieja no se consumió por un click que no le correspondía.
    expect(metadataStore.pending_fulfillment_action).toEqual(oldPending);

    // Ahora el agente vuelve a presentar los botones (para el draft nuevo).
    await markFulfillmentPending(BUSINESS_ID, PHONE, CONVERSATION_ID);
    const freshClick = await applyFulfillmentSelectionIfPending(
      BUSINESS_ID,
      PHONE,
      CONVERSATION_ID,
      'TAKE_AWAY'
    );
    expect(freshClick.applied).toBe(true);
    expect(draft?.fulfillment_type).toBe('TAKE_AWAY');
  });

  it('4) doble click: la segunda ejecución no vuelve a aplicar ni muta de nuevo', async () => {
    await markFulfillmentPending(BUSINESS_ID, PHONE, CONVERSATION_ID);

    const first = await applyFulfillmentSelectionIfPending(
      BUSINESS_ID,
      PHONE,
      CONVERSATION_ID,
      'DELIVERY'
    );
    const executeRawCallsAfterFirst = vi.mocked(prisma.$executeRaw).mock.calls.length;

    const second = await applyFulfillmentSelectionIfPending(
      BUSINESS_ID,
      PHONE,
      CONVERSATION_ID,
      'TAKE_AWAY'
    );

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.error).toBe('already_resolved');
    expect(draft?.fulfillment_type).toBe('DELIVERY');
    // El segundo click ni siquiera llega a intentar el UPDATE condicionado.
    expect(vi.mocked(prisma.$executeRaw).mock.calls.length).toBe(executeRawCallsAfterFirst);
  });

  it('5) contexto incorrecto: solicitud de otro draft no autoriza el cambio', async () => {
    await markFulfillmentPending(BUSINESS_ID, PHONE, CONVERSATION_ID);
    draft = { id: 'draft-other', fulfillment_type: null };

    const result = await applyFulfillmentSelectionIfPending(
      BUSINESS_ID,
      PHONE,
      CONVERSATION_ID,
      'DELIVERY'
    );

    expect(result.applied).toBe(false);
    expect(result.error).toBe('wrong_draft');
    expect(draft?.fulfillment_type).toBeNull();
  });

  it('6) sin solicitud pendiente registrada: el payload se rechaza sin mutación', async () => {
    const result = await applyFulfillmentSelectionIfPending(
      BUSINESS_ID,
      PHONE,
      CONVERSATION_ID,
      'DELIVERY'
    );

    expect(result.applied).toBe(false);
    expect(result.error).toBe('no_pending');
    expect(draft?.fulfillment_type).toBeNull();
  });

  it('7) fallo de persistencia: la solicitud se consume pero no queda en estado incoherente — el próximo turno la vuelve a registrar', async () => {
    await markFulfillmentPending(BUSINESS_ID, PHONE, CONVERSATION_ID);
    vi.mocked(prisma.$executeRaw).mockRejectedValueOnce(new Error('db down'));

    await expect(
      applyFulfillmentSelectionIfPending(BUSINESS_ID, PHONE, CONVERSATION_ID, 'DELIVERY')
    ).rejects.toThrow('db down');

    // La solicitud quedó consumida (no hay doble-aplicación posible si el
    // error fue transitorio y el click se reintenta tal cual)...
    expect(metadataStore.pending_fulfillment_action).toBeUndefined();
    // ...pero el draft sigue sin resolver, y el siguiente turno que vuelva a
    // presentar los botones registra una solicitud fresca sin quedar atascado.
    expect(draft?.fulfillment_type).toBeNull();
    await markFulfillmentPending(BUSINESS_ID, PHONE, CONVERSATION_ID);
    const retry = await applyFulfillmentSelectionIfPending(
      BUSINESS_ID,
      PHONE,
      CONVERSATION_ID,
      'DELIVERY'
    );
    expect(retry.applied).toBe(true);
  });

  it('sin draft activo: rechaza con no_active_cart sin tocar metadata', async () => {
    await markFulfillmentPending(BUSINESS_ID, PHONE, CONVERSATION_ID);
    draft = null;

    const result = await applyFulfillmentSelectionIfPending(
      BUSINESS_ID,
      PHONE,
      CONVERSATION_ID,
      'DELIVERY'
    );

    expect(result.applied).toBe(false);
    expect(result.error).toBe('no_active_cart');
  });
});
