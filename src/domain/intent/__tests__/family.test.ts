import { describe, it, expect } from 'vitest';
import {
  INTENT_CATALOG,
  assertIntentCatalogComplete,
  getIntentCatalogEntry,
  type IntentType,
} from '../family';

describe('INTENT_CATALOG (A.1)', () => {
  it('tiene entrada para todo IntentType del union', () => {
    expect(() => assertIntentCatalogComplete()).not.toThrow();
    const keys = Object.keys(INTENT_CATALOG) as IntentType[];
    expect(keys.length).toBeGreaterThanOrEqual(2);
    for (const key of keys) {
      expect(INTENT_CATALOG[key]).toBeDefined();
      expect(INTENT_CATALOG[key].kind).toMatch(/^(goal|opportunity|alert)$/);
    }
  });

  it('rechaza (runtime) un IntentType sin entrada de catálogo', () => {
    expect(() => getIntentCatalogEntry('NO_EXISTE' as IntentType)).toThrow(
      /sin entrada de catálogo/
    );
  });

  it('Opportunity nunca tiene presupuesto > 1 (ADR-0008 / D7)', () => {
    for (const [type, entry] of Object.entries(INTENT_CATALOG)) {
      if (entry.kind === 'opportunity') {
        expect(entry.maxSurfaces, type).toBe(1);
      }
    }
  });
});
