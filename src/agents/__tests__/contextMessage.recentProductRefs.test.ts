/**
 * `buildRecentProductRefsContextLines` (contextMessage.ts) — bloque de texto
 * de la proyección plural de productos recientes. El filtrado/dedupe en sí
 * ya está cubierto en `productResolution.service.test.ts`
 * (`listRecentEligibleProductResolutions`); acá se cubre específicamente lo
 * que agrega esta capa: exclusión de productos no disponibles y la
 * diferencia de texto entre `resolved` y `selected`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { menuFindManyMock, listRecentMock } = vi.hoisted(() => ({
  menuFindManyMock: vi.fn(),
  listRecentMock: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  prisma: { menu_item: { findMany: menuFindManyMock } },
}));

vi.mock('../../services/productResolution.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/productResolution.service')>()),
  listRecentProductResolutions: listRecentMock,
}));

import { buildRecentProductRefsContextLines } from '../contextMessage';

const BUSINESS_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONVERSATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CEVICHE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PAPAS_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const resolution = (productId: string, status: 'resolved' | 'selected') => ({
  resolutionId: `pr1:${BUSINESS_ID}:${CONVERSATION_ID}:${productId}`,
  productId,
  businessId: BUSINESS_ID,
  conversationId: CONVERSATION_ID,
  source: 'search_products' as const,
  status,
  scope: 'conversation' as const,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

describe('buildRecentProductRefsContextLines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('5) un producto ya no disponible no aparece en el texto', async () => {
    listRecentMock.mockResolvedValue([resolution(CEVICHE_ID, 'resolved')]);
    // is_available:true está en el WHERE de la query real; el mock simula
    // que esa fila no vino en el resultado (producto no disponible).
    menuFindManyMock.mockResolvedValue([]);

    const lines = await buildRecentProductRefsContextLines({}, BUSINESS_ID, CONVERSATION_ID);

    expect(lines).toEqual([]);
  });

  it('7) resolved y selected se presentan con semánticas de texto distintas', async () => {
    listRecentMock.mockResolvedValue([
      resolution(CEVICHE_ID, 'selected'),
      resolution(PAPAS_ID, 'resolved'),
    ]);
    menuFindManyMock.mockResolvedValue([
      { id: CEVICHE_ID, name: 'Ceviche Clásico' },
      { id: PAPAS_ID, name: 'Papas a la huancaína' },
    ]);

    const lines = await buildRecentProductRefsContextLines({}, BUSINESS_ID, CONVERSATION_ID);

    const cevicheLine = lines.find((l) => l.includes('Ceviche Clásico'));
    const papasLine = lines.find((l) => l.includes('Papas a la huancaína'));
    expect(cevicheLine).toContain('elegido explícitamente');
    expect(cevicheLine).toContain(CEVICHE_ID);
    expect(papasLine).toContain('consultado, sin elegir aún');
    expect(papasLine).not.toContain('elegido explícitamente');
  });

  it('sin productos recientes, no agrega ningún bloque', async () => {
    listRecentMock.mockResolvedValue([]);
    const lines = await buildRecentProductRefsContextLines({}, BUSINESS_ID, CONVERSATION_ID);
    expect(lines).toEqual([]);
    expect(menuFindManyMock).not.toHaveBeenCalled();
  });
});
