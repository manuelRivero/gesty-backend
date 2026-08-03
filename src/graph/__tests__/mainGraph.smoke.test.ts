/**
 * Test de humo: el `StateGraph` principal se construye sin error en runtime.
 * Cubre en particular el wiring del nodo `paymentProof` (Fase 3 del plan de
 * comprobantes de transferencia): el switch de `routeAfterDetectionContext`
 * y los `addNode`/`addConditionalEdges` deben quedar consistentes.
 */

import { describe, it, expect } from 'vitest';

describe('mainGraph', () => {
  it('se importa y compila sin lanzar', async () => {
    const { mainGraph } = await import('../mainGraph');
    expect(mainGraph).toBeDefined();
  });
});
