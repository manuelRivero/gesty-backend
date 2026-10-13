import { describe, expect, it, vi } from 'vitest';
import { prisma } from '../../lib/prisma';
import { buildViewCategoriesMessage } from '../category.service';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    menu_category: { findMany: vi.fn() },
  },
}));

vi.mock('../../repositories', () => ({
  createConversationMessage: vi.fn().mockResolvedValue(undefined),
  findOrCreateConversationState: vi.fn().mockResolvedValue(undefined),
  createOrGetOpenConversation: vi.fn().mockResolvedValue(undefined),
  findOrCreateCustomer: vi.fn().mockResolvedValue(undefined),
  updateConversationLastMessageAt: vi.fn().mockResolvedValue(undefined),
  findBusinessByPhoneNumberId: vi.fn().mockResolvedValue(undefined),
}));

const business = { id: 'biz-1' } as any;
const conversation = { id: 'conv-1' } as any;

describe('buildViewCategoriesMessage', () => {
  it('ya no emite filas CATEGORY:<id> ni CATEGORY_LIST_PAGE', async () => {
    vi.mocked(prisma.menu_category.findMany).mockResolvedValue([
      { id: 'cat-1', name: 'Entradas' },
      { id: 'cat-2', name: 'Postres' },
    ] as any);

    const result = await buildViewCategoriesMessage(business, conversation, 1, true);

    expect(result.message).not.toBeNull();
    expect(typeof result.message).not.toBe('string');
    const list = result.message as any;
    const rows = list.action.sections.flatMap((s: any) => s.rows);
    expect(rows.some((r: any) => typeof r.id === 'string' && r.id.startsWith('CATEGORY:'))).toBe(
      false
    );
    expect(rows.some((r: any) => r.id === 'CATEGORY_LIST_PAGE:2')).toBe(false);
    // El contenido conversacional (nombres de categoría como atajos tipables) se conserva.
    expect(list.body.text).toContain('Entradas');
    expect(list.body.text).toContain('Postres');
  });

  it('con isFromMenuReturn=true conserva la fila VIEW_MENU_RETURN', async () => {
    vi.mocked(prisma.menu_category.findMany).mockResolvedValue([
      { id: 'cat-1', name: 'Entradas' },
    ] as any);

    const result = await buildViewCategoriesMessage(business, conversation, 1, true);
    const list = result.message as any;
    const rows = list.action.sections.flatMap((s: any) => s.rows);
    expect(rows.some((r: any) => r.id === 'VIEW_MENU_RETURN')).toBe(true);
  });

  it('sin isFromMenuReturn y sin filas clickeables, devuelve texto plano (nunca una lista vacía)', async () => {
    vi.mocked(prisma.menu_category.findMany).mockResolvedValue([
      { id: 'cat-1', name: 'Entradas' },
    ] as any);

    // Simula un click en un botón CATEGORY_LIST_PAGE antiguo ya enviado a un
    // usuario: el handler legacy sigue funcionando (no se elimina), pero la
    // respuesta ya no ofrece más filas de categoría/paginación.
    const result = await buildViewCategoriesMessage(business, conversation, 2, false);

    expect(typeof result.message).toBe('string');
    expect(result.message as string).toContain('Entradas');
  });
});
