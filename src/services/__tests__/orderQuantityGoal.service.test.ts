import { describe, expect, it } from 'vitest';
import {
  deriveOrderQuantityGoalCandidate,
  deriveOrderQuantityGoalTarget,
} from '../orderQuantityGoal.service';

const metadata = {
  pendingOrderLines: {
    lines: [
      { id: 'papas-1', hint: 'papas', requestedQuantity: null, status: 'active' },
      { id: 'ceviche-1', hint: 'ceviche', requestedQuantity: null, status: 'queued' },
    ],
    sourceMessage: 'papas y ceviche',
    createdAt: '2026-09-30T00:00:00.000Z',
  },
};

describe('orderQuantityGoal.service', () => {
  it('abre solo con PEDIR activo, party size conocido y línea UNKNOWN', () => {
    const common = { checkoutActive: false, partySizeKnown: true, metadata };
    expect(deriveOrderQuantityGoalTarget({ ...common, activePedir: true })?.id).toBe('papas-1');
    expect(deriveOrderQuantityGoalTarget({ ...common, activePedir: false })).toBeNull();
    expect(deriveOrderQuantityGoalTarget({ ...common, activePedir: true, checkoutActive: true })).toBeNull();
    expect(deriveOrderQuantityGoalTarget({ ...common, activePedir: true, partySizeKnown: false })).toBeNull();
  });

  it('emite fulfillment contract y referencia estable del target', () => {
    const candidate = deriveOrderQuantityGoalCandidate(
      { activePedir: true, checkoutActive: false, partySizeKnown: true, metadata },
      undefined,
      Date.parse('2026-09-30T00:00:00.000Z')
    );
    expect(candidate).toMatchObject({
      type: 'OBTENER_CANTIDAD_DEL_PRODUCTO',
      pressure: 'blocking',
      fulfillment: {
        requiredFact: 'CANTIDAD_DEL_PRODUCTO',
        fulfillmentTool: 'set_order_line_quantity',
        expectedEffect: 'order_line_quantity_persisted',
      },
    });
    expect(candidate?.hint).toContain('orderLineId: papas-1');
  });

  it('no infiere cantidad desde una sugerencia y apunta a la siguiente UNKNOWN', () => {
    const knownFirst = {
      pendingOrderLines: {
        ...metadata.pendingOrderLines,
        lines: metadata.pendingOrderLines.lines.map((line, index) =>
          index === 0 ? { ...line, requestedQuantity: 2 } : line
        ),
      },
    };
    expect(
      deriveOrderQuantityGoalTarget({
        activePedir: true,
        checkoutActive: false,
        partySizeKnown: true,
        metadata: knownFirst,
      })?.id
    ).toBe('ceviche-1');
  });
});