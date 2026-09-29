import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  findMenuItem,
  selectFromButton,
  handleAddItem,
  setPendingVariation,
  maybeSetPendingAddQuantity,
  isConfirmedAddQuantity,
} = vi.hoisted(() => ({
  findMenuItem: vi.fn(),
  selectFromButton: vi.fn(),
  handleAddItem: vi.fn(),
  setPendingVariation: vi.fn(),
  maybeSetPendingAddQuantity: vi.fn(),
  isConfirmedAddQuantity: vi.fn(),
}));

vi.mock('../../../../lib/prisma', () => ({
  prisma: { menu_item: { findFirst: findMenuItem } },
}));
vi.mock('../../../../services/ordersCapabilityGate.service', () => ({
  assertCanOrder: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../../../services/productResolution.service', () => ({
  productResolutionErrorMessage: vi.fn(() => 'Elegí de nuevo el producto.'),
  selectProductResolutionFromButton: selectFromButton,
}));
vi.mock('../../../../services/cart.service', () => ({
  buildVariationPickerList: vi.fn(() => ({ type: 'list' })),
  handleAddItemFromWebhook: handleAddItem,
}));
vi.mock('../../../../services/pendingVariation.service', () => ({
  clearPendingVariation: vi.fn(),
  getPendingVariation: vi.fn().mockReturnValue(null),
  setPendingVariation,
}));
vi.mock('../../../../services/pendingAddQuantity.service', () => ({
  buildPendingAddQuantityMessage: vi.fn(() => '¿Cuántas?'),
  clearPendingAddQuantity: vi.fn(),
  getPendingAddQuantity: vi.fn().mockReturnValue(null),
  maybeSetPendingAddQuantity,
}));
vi.mock('../../../../services/addQuantitySuggestion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../services/addQuantitySuggestion')>();
  return {
    ...actual,
    isConfirmedAddQuantity,
    suggestAddQuantity: vi.fn(({ partySize }: { partySize: number | null }) => ({
      suggestedQuantity: partySize ?? 1,
    })),
  };
});

import { AddItemHandler } from '../addItemHandler';

const BUSINESS_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONVERSATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PRODUCT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RESOLUTION_ID = `pr1:${BUSINESS_ID}:${CONVERSATION_ID}:dddddddd-dddd-4ddd-8ddd-dddddddddddd`;

const context = (payloadId: string, metadata: Record<string, unknown> = { peopleCount: 1 }) => ({
  payloadId,
  payload: {},
  business: { id: BUSINESS_ID },
  conversation: { id: CONVERSATION_ID },
  conversationState: { metadata },
  customer: { id: 'customer-1', phone_number: '+5491100000000' },
});

describe('AddItemHandler ProductResolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectFromButton.mockResolvedValue({
      ok: true,
      resolution: { resolutionId: RESOLUTION_ID, productId: PRODUCT_ID },
    });
    findMenuItem.mockResolvedValue({
      id: PRODUCT_ID,
      name: 'Producto de prueba',
      variations: [],
      serves_people: 1,
    });
    handleAddItem.mockResolvedValue('Agregado');
    maybeSetPendingAddQuantity.mockResolvedValue(null);
    isConfirmedAddQuantity.mockReturnValue(true);
  });

  it('promueve el candidato del botón y pasa la misma resolución al writer compartido', async () => {
    const result = await new AddItemHandler().execute(
      context(`ADD_ITEM:${PRODUCT_ID}:1`) as never
    );

    expect(selectFromButton).toHaveBeenCalledWith({
      productId: PRODUCT_ID,
      businessId: BUSINESS_ID,
      conversationId: CONVERSATION_ID,
    });
    expect(handleAddItem).toHaveBeenCalledWith(
      {},
      PRODUCT_ID,
      1,
      'add',
      null,
      RESOLUTION_ID
    );
    expect(result).toMatchObject({ content: 'Agregado', isInteractive: false });
  });

  it('conserva la resolución cuando el botón abre una pregunta de cantidad', async () => {
    isConfirmedAddQuantity.mockReturnValue(false);
    maybeSetPendingAddQuantity.mockResolvedValue({
      productId: PRODUCT_ID,
      productName: 'Producto de prueba',
      suggestedQuantity: 4,
    });

    await new AddItemHandler().execute(
      context(`ADD_ITEM:${PRODUCT_ID}`, { peopleCount: 4, requestedPartySize: 4 }) as never
    );

    expect(maybeSetPendingAddQuantity).toHaveBeenCalledWith(
      expect.objectContaining({ productId: PRODUCT_ID, productResolutionId: RESOLUTION_ID })
    );
    expect(handleAddItem).not.toHaveBeenCalled();
  });

  it('conserva la resolución si el botón abre el selector de variación', async () => {
    findMenuItem.mockResolvedValue({
      id: PRODUCT_ID,
      name: 'Pizza',
      variations: ['Especial', 'Roquefort'],
      serves_people: 1,
    });

    const result = await new AddItemHandler().execute(
      context(`ADD_ITEM:${PRODUCT_ID}:1`) as never
    );

    expect(setPendingVariation).toHaveBeenCalledWith(
      expect.objectContaining({ productId: PRODUCT_ID, productResolutionId: RESOLUTION_ID })
    );
    expect(handleAddItem).not.toHaveBeenCalled();
    expect(result?.isInteractive).toBe(true);
  });
});