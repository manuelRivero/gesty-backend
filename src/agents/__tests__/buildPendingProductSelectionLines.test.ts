/**
 * Regresión R2: tras `resolve_product` confirmar un candidato del shortlist,
 * si `add_cart_item` bloquea por otra precondición (ej.
 * `order_line_quantity_required`), el shortlist ya no debe volver a
 * presentarse como pendiente — ver docs/arquitectura (análisis R2) y
 * `shortlistAwaitingUserChoice` en pendingOrderLines.service.ts (mismo corte,
 * evidencia: CASE08).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    menu_item: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

import { buildPendingProductSelectionLines } from '../contextMessage';

const BUSINESS_ID = 'biz-1';
const PRODUCT_A = 'prod-ceviche-a';
const PRODUCT_B = 'prod-ceviche-b';
const RESOLUTION_ID = 'res-1';

const orderLine = (overrides: Record<string, unknown> = {}) => ({
  id: 'line-1',
  hint: 'ceviche',
  requestedQuantity: null,
  status: 'active',
  currentResolutionId: null,
  pendingNote: null,
  ...overrides,
});

const baseMeta = (overrides: Record<string, unknown> = {}) => ({
  pendingProductSelection: true,
  candidateProductIds: [PRODUCT_A, PRODUCT_B],
  productResolutions: [] as Array<Record<string, unknown>>,
  pendingOrderLines: {
    lines: [orderLine()],
    sourceMessage: 'quiero un ceviche',
    createdAt: new Date().toISOString(),
  },
  ...overrides,
});

describe('buildPendingProductSelectionLines — R2', () => {
  it('no vuelve a presentar el shortlist cuando la línea activa ya tiene una resolución confirmada (selected) de uno de los candidatos', async () => {
    const meta = baseMeta({
      pendingOrderLines: {
        lines: [orderLine({ currentResolutionId: RESOLUTION_ID })],
        sourceMessage: 'quiero un ceviche',
        createdAt: new Date().toISOString(),
      },
      productResolutions: [
        {
          resolutionId: RESOLUTION_ID,
          productId: PRODUCT_A,
          businessId: BUSINESS_ID,
          status: 'selected',
        },
      ],
    });

    const lines = await buildPendingProductSelectionLines(meta, BUSINESS_ID);

    expect(lines).toEqual([]);
  });

  it('control positivo: sin resolución confirmada, el shortlist sigue apareciendo como pendiente', async () => {
    const meta = baseMeta();

    const lines = await buildPendingProductSelectionLines(meta, BUSINESS_ID);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('Selección de producto pendiente'))).toBe(true);
  });

  it('aislamiento por línea: una resolución confirmada de OTRA línea (sin relación con este shortlist) no lo oculta', async () => {
    const meta = baseMeta({
      pendingOrderLines: {
        lines: [
          orderLine({ id: 'line-1', currentResolutionId: null, status: 'active' }),
          orderLine({ id: 'line-2', hint: 'papas', currentResolutionId: 'res-papas', status: 'queued' }),
        ],
        sourceMessage: 'quiero un ceviche y unas papas',
        createdAt: new Date().toISOString(),
      },
      productResolutions: [
        {
          resolutionId: 'res-papas',
          productId: 'prod-papas',
          businessId: BUSINESS_ID,
          status: 'selected',
        },
      ],
    });

    const lines = await buildPendingProductSelectionLines(meta, BUSINESS_ID);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('Selección de producto pendiente'))).toBe(true);
  });

  it('resolución no coincidente: currentResolutionId resuelto a un producto que no es ninguno de los candidatos no se trata como shortlist resuelto', async () => {
    const meta = baseMeta({
      pendingOrderLines: {
        lines: [orderLine({ currentResolutionId: RESOLUTION_ID })],
        sourceMessage: 'quiero un ceviche',
        createdAt: new Date().toISOString(),
      },
      productResolutions: [
        {
          resolutionId: RESOLUTION_ID,
          productId: 'prod-no-relacionado',
          businessId: BUSINESS_ID,
          status: 'selected',
        },
      ],
    });

    const lines = await buildPendingProductSelectionLines(meta, BUSINESS_ID);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('Selección de producto pendiente'))).toBe(true);
  });

  it('resolución con status distinto de selected (candidate) no se trata como shortlist resuelto', async () => {
    const meta = baseMeta({
      pendingOrderLines: {
        lines: [orderLine({ currentResolutionId: RESOLUTION_ID })],
        sourceMessage: 'quiero un ceviche',
        createdAt: new Date().toISOString(),
      },
      productResolutions: [
        {
          resolutionId: RESOLUTION_ID,
          productId: PRODUCT_A,
          businessId: BUSINESS_ID,
          status: 'candidate',
        },
      ],
    });

    const lines = await buildPendingProductSelectionLines(meta, BUSINESS_ID);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('Selección de producto pendiente'))).toBe(true);
  });
});
