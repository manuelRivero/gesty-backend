/**
 * Contrato semántico: "eliminación total" (remove_cart_item) vs "reducción/cambio de
 * cantidad" (update_cart_item_quantity) para los mismos verbos ("sacar"/"quitar").
 *
 *   "quitá las papas" / "sacá las papas" / "no quiero las papas"  → remove_cart_item
 *   "quitá una papa" / "sacame una" / "sacá 1 de las papas"        → update_cart_item_quantity
 *   "dejame 2" / "dejame una sola"                                 → update_cart_item_quantity
 *
 * IMPORTANTE — alcance de este archivo: la selección de tool a partir de lenguaje natural la
 * hace el LLM (ver botPersonality.ts y la descripción de cada tool); no existe en este
 * proyecto infraestructura para invocar un modelo real y verificar su elección a nivel de test
 * unitario, y construir una nueva (o un E2E ad hoc) está fuera del alcance de este fix — un
 * E2E real además resultó frágil en la práctica (ambigüedad de nombres de producto en el menú
 * de prueba produce un shortlist en lugar de un add directo, variable de corrida a corrida).
 *
 * Lo que ESTE archivo fija y SÍ puede garantizar de forma determinística es el contrato que
 * debe cumplirse UNA VEZ que el modelo eligió una tool para cada una de esas frases:
 *   - remove_cart_item siempre borra la línea completa (nunca una reducción parcial).
 *   - update_cart_item_quantity siempre fija la cantidad FINAL que describe la frase
 *     (nunca como delta, nunca eliminando la línea).
 * Documenta el nombre de cada test con la frase real para que una futura auditoría de
 * selección de tool (manual o con un model-eval dedicado) tenga un mapeo claro contra el que
 * comparar el comportamiento observado del modelo.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    draft_order_item: {
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      aggregate: vi.fn(),
    },
  },
}));

vi.mock('../../services/menu.service', () => ({ MenuService: {} }));

import { removeCartItemTool, updateCartItemQuantityTool } from '../index';
import { prisma } from '../../lib/prisma';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

const DRAFT = { id: 'draft-1' };
const PAPAS_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const papasLine = (quantity: number) => ({
  id: PAPAS_ID,
  product_id: PAPAS_ID,
  variation: null,
  quantity,
  unit_price: 10000,
  notes: null,
  menu_item: { id: PAPAS_ID, name: 'Papa a la huancaína' },
});
const otherLine = () => ({
  id: OTHER_ID,
  product_id: OTHER_ID,
  variation: null,
  quantity: 1,
  unit_price: 5000,
  notes: null,
  menu_item: { id: OTHER_ID, name: 'Ají de gallina' },
});

const callRemove = (itemIndex: number) => removeCartItemTool.func({ itemIndex }, undefined, CONFIG);
const callUpdate = (itemIndex: number, quantity: number) =>
  updateCartItemQuantityTool.func({ itemIndex, quantity }, undefined, CONFIG);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(DRAFT as never);
  vi.mocked(prisma.draft_order_item.aggregate).mockResolvedValue({ _sum: { total_price: 0 } } as never);
  vi.mocked(prisma.draft_order_item.update).mockResolvedValue({} as never);
  vi.mocked(prisma.draft_order.update).mockResolvedValue({} as never);
});

describe('contrato: "sacar/quitar" sin cantidad parcial → remove_cart_item (elimina toda la línea)', () => {
  it.each([
    ['quitá las papas'],
    ['sacá las papas'],
    ['no quiero las papas'],
  ])('%s → remove_cart_item elimina la línea completa, no solo una unidad', async (_phrase) => {
    vi.mocked(prisma.draft_order_item.findMany)
      .mockResolvedValueOnce([papasLine(3), otherLine()] as never)
      .mockResolvedValueOnce([otherLine()] as never);

    const result = JSON.parse((await callRemove(1)) as string);

    expect(result.success).toBe(true);
    expect(result.removed).toEqual({ itemName: 'Papa a la huancaína', quantity: 3 });
    expect(prisma.draft_order_item.delete).toHaveBeenCalledWith({ where: { id: PAPAS_ID } });
    // La línea desaparece: no queda en "2" ni en ningún resto parcial.
    expect(result.cart.items.some((item: { name: string }) => item.name === 'Papa a la huancaína')).toBe(false);
  });
});

describe('contrato: "sacar/quitar" + cantidad parcial → update_cart_item_quantity (cantidad FINAL, no delta)', () => {
  it.each([
    ['sacame una', 2],
    ['quitá una papa', 2],
    ['sacá 1 de las papas', 2],
    ['dejame 2', 2],
    ['dejame una sola', 1],
  ])('%s (papas ×3) → update_cart_item_quantity con quantity FINAL = %i, nunca remove_cart_item', async (_phrase, finalQuantity) => {
    vi.mocked(prisma.draft_order_item.findMany)
      .mockResolvedValueOnce([papasLine(3), otherLine()] as never)
      .mockResolvedValueOnce([papasLine(finalQuantity as number), otherLine()] as never);

    const result = JSON.parse((await callUpdate(1, finalQuantity as number)) as string);

    expect(result.success).toBe(true);
    // quantity FINAL, no un delta de "restar 1" sobre otro valor: queda exactamente lo pedido.
    expect(result.updated).toEqual({ itemIndex: 1, itemName: 'Papa a la huancaína', quantity: finalQuantity });
    expect(prisma.draft_order_item.delete).not.toHaveBeenCalled();
    // La línea sigue existiendo (remove_cart_item nunca corrió para este caso).
    expect(result.cart.items.some((item: { name: string }) => item.name === 'Papa a la huancaína')).toBe(true);
  });

  it('"dejame una sola" nunca puede expresarse como quantity:0 (la tool exige ≥ 1): la eliminación total sigue siendo remove_cart_item', async () => {
    const result = JSON.parse((await callUpdate(1, 0)) as string);

    expect(result.success).toBe(false);
    expect(result.error).toBe('quantity_invalid');
    expect(prisma.draft_order_item.update).not.toHaveBeenCalled();
    expect(prisma.draft_order_item.delete).not.toHaveBeenCalled();
  });
});
