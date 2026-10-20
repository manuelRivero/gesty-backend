/**
 * Reproducción determinista + verificación del fix de una interacción
 * encontrada al validar la transición EXPLORAR→PEDIR por aceptación de
 * oferta viva (ver `humanIntentPreflight.ts`, regla de `context.activeOffer`):
 *
 * BUG (reproducido en el describe "bug"): cuando el preflight sintetiza un
 * `NEW_INTENT PEDIR` con `request: { products: [{ name, productId }] }` para
 * representar el producto aceptado, `dispatch/index.ts` (líneas ~947-957)
 * llama SIEMPRE `ensurePendingOrderLinesFromRequest(activePedir.request, ...)`
 * para cualquier PEDIR que quede ACTIVE — sin relación con `plan_order_lines`.
 * Esto materializa una `pendingOrderLines` con una línea en status 'active'
 * para ESE único producto, lo cual activa `taskBound` en
 * `requirementEvaluator.ts` y exige `orderLineId` + `resolutionId` en
 * `add_cart_item` — algo que el flujo de "oferta viva" (`lastOffer.service.ts`)
 * nunca le pide al modelo (su instrucción es `add_cart_item` directo con el
 * productId, sin orderLineId). Esto se vio en el E2E
 * `last-offer-add-item.e2e.test.ts` (caso B) tras esa transición.
 *
 * FIX (verificado en el describe "fix"): `humanIntentPreflight.ts` ahora
 * sintetiza `request: { offeredProducts: [...] }` (no `products`) para esta
 * transición puntual. `parseRequestProducts` (pendingOrderLines.service.ts)
 * solo mira la clave literal `products`, así que `offeredProducts` nunca
 * materializa la cola — `add_cart_item` sigue el camino directo (no
 * task-bound), igual que cualquier otro `add_cart_item` tras una oferta viva.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const metadataStore: { value: Record<string, unknown> } = { value: {} };

const { patchConversationMetadataMock, conversationStateFindUniqueMock, resolveProductForAddMock } = vi.hoisted(() => ({
  patchConversationMetadataMock: vi.fn(),
  conversationStateFindUniqueMock: vi.fn(),
  resolveProductForAddMock: vi.fn(),
}));

vi.mock('../../repositories', () => ({
  patchConversationMetadata: (...args: [string, Record<string, unknown>]) =>
    patchConversationMetadataMock(...args),
  omitConversationMetadataKeys: vi.fn(),
  mutateConversationMetadata: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  prisma: {
    conversation_state: { findUnique: conversationStateFindUniqueMock },
  },
}));

vi.mock('../productResolution.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../productResolution.service')>()),
  resolveProductForAdd: resolveProductForAddMock,
}));

import { ensurePendingOrderLinesFromRequest, getPendingOrderLines } from '../pendingOrderLines.service';
import { evaluateToolRequirement } from '../requirementEvaluator';
import type { HumanIntentRecord } from '../humanIntentState.service';

const PRODUCT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONVERSATION_ID = 'conv-1';
const BUSINESS_ID = 'biz-1';

const activePedirWithProducts: HumanIntentRecord = {
  id: 'intent-1',
  sequence: 1,
  goal: 'PEDIR',
  // Shape pre-fix (bug): "products" dispara ensurePendingOrderLinesFromRequest.
  request: { products: [{ name: 'Ceviche Clásico', productId: PRODUCT_ID }] },
  status: 'ACTIVE',
  blockers: [],
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
};

const activePedirWithOfferedProducts: HumanIntentRecord = {
  ...activePedirWithProducts,
  id: 'intent-2',
  // Shape post-fix: "offeredProducts" preserva identidad sin disparar la cola.
  request: { offeredProducts: [{ name: 'Ceviche Clásico', productId: PRODUCT_ID }] },
};

describe('interacción activeOffer→NEW_INTENT PEDIR con pendingOrderLines/taskBound', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metadataStore.value = {};
    patchConversationMetadataMock.mockImplementation(
      async (_conversationId: string, patch: Record<string, unknown>) => {
        metadataStore.value = { ...metadataStore.value, ...patch };
      }
    );
    conversationStateFindUniqueMock.mockImplementation(async () => ({ metadata: metadataStore.value }));
    resolveProductForAddMock.mockResolvedValue({
      ok: true,
      resolution: { productId: PRODUCT_ID, resolutionId: 'resolution-1' },
    });
  });

  describe('bug (pre-fix): request.products dispara la cola y bloquea el add directo', () => {
    it('ensurePendingOrderLinesFromRequest materializa una línea "active" para el único producto del PEDIR recién abierto', async () => {
      const result = await ensurePendingOrderLinesFromRequest({
        conversationId: CONVERSATION_ID,
        request: activePedirWithProducts.request,
        sourceMessage: 'Bueno dale',
        metadata: metadataStore.value,
      });

      expect(result?.lines).toHaveLength(1);
      expect(result?.lines[0]).toMatchObject({ hint: 'Ceviche Clásico', status: 'active' });
      expect(getPendingOrderLines(metadataStore.value)?.lines[0]?.status).toBe('active');
    });

    it('con esa pendingOrderLines ya materializada, add_cart_item(productId) SIN orderLineId queda DEFER por order_line_id_required', async () => {
      await ensurePendingOrderLinesFromRequest({
        conversationId: CONVERSATION_ID,
        request: activePedirWithProducts.request,
        sourceMessage: 'Bueno dale',
        metadata: metadataStore.value,
      });

      // Mismo llamado que hace el modelo tras aceptar la oferta viva (sin
      // orderLineId: lastOffer.service.ts nunca le pide pasar uno).
      const decision = await evaluateToolRequirement({
        toolName: 'add_cart_item',
        callArgs: { productId: PRODUCT_ID, quantity: 1 },
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
        humanIntent: activePedirWithProducts,
      });

      expect(decision).toMatchObject({
        type: 'DEFER',
        reason: 'order_line_id_required',
        missingRequirements: ['TASK_RESOLUTION_PAIR'],
      });
      expect(resolveProductForAddMock).not.toHaveBeenCalled();
    });
  });

  describe('fix: request.offeredProducts NO dispara la cola — add_cart_item sigue el camino directo', () => {
    it('ensurePendingOrderLinesFromRequest es no-op para offeredProducts: no crea pendingOrderLines', async () => {
      const result = await ensurePendingOrderLinesFromRequest({
        conversationId: CONVERSATION_ID,
        request: activePedirWithOfferedProducts.request,
        sourceMessage: 'Bueno dale',
        metadata: metadataStore.value,
      });

      expect(result).toBeNull();
      expect(getPendingOrderLines(metadataStore.value)).toBeNull();
      expect(patchConversationMetadataMock).not.toHaveBeenCalled();
    });

    it('sin pendingOrderLines, add_cart_item(productId) SIN orderLineId queda ALLOW (camino directo de oferta viva, igual que siempre)', async () => {
      await ensurePendingOrderLinesFromRequest({
        conversationId: CONVERSATION_ID,
        request: activePedirWithOfferedProducts.request,
        sourceMessage: 'Bueno dale',
        metadata: metadataStore.value,
      });

      const decision = await evaluateToolRequirement({
        toolName: 'add_cart_item',
        callArgs: { productId: PRODUCT_ID, quantity: 1 },
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
        humanIntent: activePedirWithOfferedProducts,
      });

      expect(decision).toEqual({ type: 'ALLOW' });
      // Camino no-task-bound: resuelve contra la ProductResolution de la
      // oferta viva (lastOffer.service.ts emite status 'resolved'), no exige
      // orderLineId/resolutionId.
      expect(resolveProductForAddMock).toHaveBeenCalledWith(
        expect.objectContaining({ productId: PRODUCT_ID })
      );
    });
  });
});
