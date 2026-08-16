import { describe, expect, it } from 'vitest';
import {
  coercePromotionInterpreterOutput,
  extractJsonTextFromStructuredOutputError,
  tryParseJsonObject,
} from '../coercePromotionInterpreterOutput';

describe('coercePromotionInterpreterOutput', () => {
  it('recupera el JSON aplanado observado en producción (admin audio)', () => {
    const flat = {
      name: 'Martes de hamburguesas con papas fritas gratis',
      status: 'complete',
      conditions: [
        {
          field: 'cart.product',
          operator: 'gte',
          value: { productName: 'hamburguesa', quantity: 1 },
        },
      ],
      benefit: {
        type: 'free_product',
        productName: 'papas fritas',
        quantity: 1,
      },
      daysOfWeek: [2],
      timeRange: { from: '18:00', to: '20:00' },
      unresolvedEntities: [],
    };

    const coerced = coercePromotionInterpreterOutput(flat);
    expect(coerced).not.toBeNull();
    expect(coerced?.status).toBe('complete');
    expect(coerced?.offer.name).toBe('Martes de hamburguesas con papas fritas gratis');
    expect(coerced?.offer.benefit).toEqual({
      type: 'free_product',
      productName: 'papas fritas',
      quantity: 1,
    });
    expect(coerced?.offer.validity).toEqual({
      daysOfWeek: [2],
      timeRange: { from: '18:00', to: '20:00' },
    });
    expect(coerced?.missingInformation).toEqual([]);
    expect(coerced?.unresolvedEntities).toEqual([]);
  });

  it('acepta el envelope canónico y completa arrays omitidos', () => {
    const nested = {
      status: 'complete',
      offer: {
        name: 'Promo',
        conditions: [],
        benefit: { type: 'percentage_discount', value: 10 },
      },
    };

    const coerced = coercePromotionInterpreterOutput(nested);
    expect(coerced?.missingInformation).toEqual([]);
    expect(coerced?.unresolvedEntities).toEqual([]);
    expect(coerced?.offer.benefit).toEqual({ type: 'percentage_discount', value: 10 });
  });
});

describe('extractJsonTextFromStructuredOutputError', () => {
  it('extrae llmOutput cuando existe (OutputParserException)', () => {
    const flat = {
      name: 'Martes de hamburguesas',
      status: 'complete',
      conditions: [],
      benefit: { type: 'free_product', productName: 'papas', quantity: 1 },
      daysOfWeek: [2],
      timeRange: { from: '18:00', to: '20:00' },
      unresolvedEntities: [],
    };
    const error = Object.assign(new Error('Failed to parse'), {
      llmOutput: JSON.stringify(flat),
    });

    const extracted = extractJsonTextFromStructuredOutputError(error);
    const coerced = coercePromotionInterpreterOutput(tryParseJsonObject(extracted!));
    expect(coerced?.offer.name).toBe('Martes de hamburguesas');
    expect(coerced?.offer.validity?.daysOfWeek).toEqual([2]);
  });

  it('extrae el Text del mensaje cuando no hay llmOutput', () => {
    const flatJson = `{
  "name": "Martes de hamburguesas",
  "status": "complete",
  "conditions": [],
  "benefit": { "type": "free_product", "productName": "papas", "quantity": 1 },
  "daysOfWeek": [2],
  "timeRange": { "from": "18:00", "to": "20:00" },
  "unresolvedEntities": []
}`;
    const error = new Error(
      `Failed to parse. Text: "${flatJson}". Error: [\n  {\n    "path": ["offer"]\n  }\n]`
    );

    const extracted = extractJsonTextFromStructuredOutputError(error);
    expect(extracted).toBeTruthy();
    const coerced = coercePromotionInterpreterOutput(tryParseJsonObject(extracted!));
    expect(coerced?.offer.name).toBe('Martes de hamburguesas');
  });
});
