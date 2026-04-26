/**
 * Tests unitarios para buildHybridCtaInteractive y helpers de hybridCta.ts
 *
 * No requieren conexión a BD ni LLM — son tests puramente de lógica de builder.
 */

import { describe, it, expect } from 'vitest';
import {
  buildHybridCtaInteractive,
  extractPrimaryPayload,
  extractPrimaryProductId,
} from '../../whatsappBuilders/hybridCta';
import type { CtaPlan } from '../types';

// ---------------------------------------------------------------------------
// buildHybridCtaInteractive
// ---------------------------------------------------------------------------

describe('buildHybridCtaInteractive', () => {
  const TEXT = '🤖\n\n*Ceviche Clásico* 🐟\n\nEs un poco picante. Ingredientes: limón, ají.';

  describe('ADD_ITEM plan', () => {
    it('devuelve HandlerResult interactivo con botón ADD_ITEM y escape secundario', () => {
      const plan: CtaPlan = {
        primary: { kind: 'ADD_ITEM', productId: 'prod-123', quantity: 1, label: 'Agregar 🛒' },
        secondary: { kind: 'VIEW_FEATURED', label: 'Ver destacados' },
      };

      const result = buildHybridCtaInteractive(TEXT, plan);

      expect(result).not.toBeNull();
      expect(result!.isInteractive).toBe(true);

      const interactive = (result!.content as any).interactive;
      expect(interactive.type).toBe('button');
      expect(interactive.action.buttons).toHaveLength(2);

      const [primary, secondary] = interactive.action.buttons;
      expect(primary.reply.id).toBe('ADD_ITEM:prod-123:1');
      expect(primary.reply.title).toBe('Agregar 🛒');
      expect(secondary.reply.id).toBe('FEATURED_PAGE:1');
      expect(secondary.reply.title).toBe('Ver destacados');
    });

    it('agrega escape VIEW_FEATURED automáticamente si no hay secondary', () => {
      const plan: CtaPlan = {
        primary: { kind: 'ADD_ITEM', productId: 'prod-456', quantity: 2, label: 'Agregar' },
      };

      const result = buildHybridCtaInteractive(TEXT, plan);
      const buttons = (result!.content as any).interactive.action.buttons;

      expect(buttons.length).toBeGreaterThanOrEqual(2);
      const ids = buttons.map((b: any) => b.reply.id as string);
      expect(ids.some((id: string) => id === 'FEATURED_PAGE:1' || id === 'VIEW_MENU')).toBe(true);
    });

    it('incluye quantity en el payload', () => {
      const plan: CtaPlan = {
        primary: { kind: 'ADD_ITEM', productId: 'prod-789', quantity: 3, label: 'Agregar' },
        secondary: { kind: 'VIEW_MENU', label: 'Ver menú' },
      };

      const result = buildHybridCtaInteractive(TEXT, plan);
      const primaryBtn = (result!.content as any).interactive.action.buttons[0];
      expect(primaryBtn.reply.id).toBe('ADD_ITEM:prod-789:3');
    });
  });

  describe('VIEW_MENU plan', () => {
    it('devuelve botón VIEW_MENU con payload correcto', () => {
      const plan: CtaPlan = {
        primary: { kind: 'VIEW_MENU', label: 'Ver menú' },
        secondary: { kind: 'VIEW_FEATURED', label: 'Ver destacados' },
      };

      const result = buildHybridCtaInteractive(TEXT, plan);
      expect(result!.isInteractive).toBe(true);

      const buttons = (result!.content as any).interactive.action.buttons;
      expect(buttons[0].reply.id).toBe('VIEW_MENU');
      expect(buttons[1].reply.id).toBe('FEATURED_PAGE:1');
    });
  });

  describe('VIEW_FEATURED plan', () => {
    it('devuelve botón FEATURED_PAGE:1 con payload correcto', () => {
      const plan: CtaPlan = {
        primary: { kind: 'VIEW_FEATURED', label: 'Ver destacados' },
      };

      const result = buildHybridCtaInteractive(TEXT, plan);
      const primaryBtn = (result!.content as any).interactive.action.buttons[0];
      expect(primaryBtn.reply.id).toBe('FEATURED_PAGE:1');
    });
  });

  describe('SELECT_FROM_LIST plan', () => {
    it('devuelve lista interactiva con filas SELECT_PRODUCT', () => {
      const plan: CtaPlan = {
        primary: {
          kind: 'SELECT_FROM_LIST',
          candidates: [
            { productId: 'p1', title: 'Ceviche Clásico', description: 'Con limón y ají' },
            { productId: 'p2', title: 'Ceviche Mixto', description: 'Con mariscos' },
          ],
          bodyText: TEXT,
        },
      };

      const result = buildHybridCtaInteractive(TEXT, plan);
      expect(result!.isInteractive).toBe(true);

      const listMsg = result!.content as any;
      expect(listMsg.type).toBe('list');

      const allRowIds: string[] = listMsg.action.sections
        .flatMap((s: any) => s.rows.map((r: any) => r.id as string));

      expect(allRowIds).toContain('SELECT_PRODUCT:p1');
      expect(allRowIds).toContain('SELECT_PRODUCT:p2');
      expect(allRowIds).toContain('VIEW_MENU');
    });

    it('limita a 5 candidatos máximo', () => {
      const candidates = Array.from({ length: 8 }, (_, i) => ({
        productId: `p${i}`,
        title: `Producto ${i}`,
      }));

      const plan: CtaPlan = {
        primary: { kind: 'SELECT_FROM_LIST', candidates, bodyText: TEXT },
      };

      const result = buildHybridCtaInteractive(TEXT, plan);
      const listMsg = result!.content as any;
      const productRows = listMsg.action.sections
        .flatMap((s: any) => s.rows)
        .filter((r: any) => (r.id as string).startsWith('SELECT_PRODUCT:'));

      expect(productRows.length).toBeLessThanOrEqual(5);
    });
  });

  describe('validaciones WhatsApp', () => {
    it('trunca títulos de botón a 20 caracteres', () => {
      const plan: CtaPlan = {
        primary: {
          kind: 'ADD_ITEM',
          productId: 'p1',
          quantity: 1,
          label: 'Este título es muy largo para WhatsApp',
        },
        secondary: { kind: 'VIEW_MENU', label: 'Ver menú completo aquí' },
      };

      const result = buildHybridCtaInteractive(TEXT, plan);
      const buttons = (result!.content as any).interactive.action.buttons;
      buttons.forEach((btn: any) => {
        expect((btn.reply.title as string).length).toBeLessThanOrEqual(20);
      });
    });

    it('payload no supera 255 caracteres', () => {
      const longId = 'a'.repeat(300);
      const plan: CtaPlan = {
        primary: { kind: 'ADD_ITEM', productId: longId, quantity: 1, label: 'Agregar' },
        secondary: { kind: 'VIEW_MENU', label: 'Ver menú' },
      };

      const result = buildHybridCtaInteractive(TEXT, plan);
      const buttons = (result!.content as any).interactive.action.buttons;
      buttons.forEach((btn: any) => {
        expect((btn.reply.id as string).length).toBeLessThanOrEqual(255);
      });
    });

    it('máximo 3 botones en mensaje reply', () => {
      const plan: CtaPlan = {
        primary: { kind: 'ADD_ITEM', productId: 'p1', quantity: 1, label: 'Agregar' },
        secondary: { kind: 'VIEW_MENU', label: 'Ver menú' },
      };

      const result = buildHybridCtaInteractive(TEXT, plan);
      const buttons = (result!.content as any).interactive.action.buttons;
      expect(buttons.length).toBeLessThanOrEqual(3);
    });
  });
});

// ---------------------------------------------------------------------------
// extractPrimaryPayload / extractPrimaryProductId
// ---------------------------------------------------------------------------

describe('extractPrimaryPayload', () => {
  it('ADD_ITEM → ADD_ITEM:<id>:<qty>', () => {
    const plan: CtaPlan = {
      primary: { kind: 'ADD_ITEM', productId: 'abc', quantity: 2, label: 'Agregar' },
    };
    expect(extractPrimaryPayload(plan)).toBe('ADD_ITEM:abc:2');
  });

  it('VIEW_MENU → VIEW_MENU', () => {
    const plan: CtaPlan = { primary: { kind: 'VIEW_MENU', label: 'Ver menú' } };
    expect(extractPrimaryPayload(plan)).toBe('VIEW_MENU');
  });

  it('VIEW_FEATURED → FEATURED_PAGE:1', () => {
    const plan: CtaPlan = { primary: { kind: 'VIEW_FEATURED', label: 'Ver destacados' } };
    expect(extractPrimaryPayload(plan)).toBe('FEATURED_PAGE:1');
  });

  it('SELECT_FROM_LIST → null', () => {
    const plan: CtaPlan = {
      primary: { kind: 'SELECT_FROM_LIST', candidates: [], bodyText: '' },
    };
    expect(extractPrimaryPayload(plan)).toBeNull();
  });
});

describe('extractPrimaryProductId', () => {
  it('ADD_ITEM → productId', () => {
    const plan: CtaPlan = {
      primary: { kind: 'ADD_ITEM', productId: 'xyz', quantity: 1, label: 'Agregar' },
    };
    expect(extractPrimaryProductId(plan)).toBe('xyz');
  });

  it('VIEW_MENU → null', () => {
    const plan: CtaPlan = { primary: { kind: 'VIEW_MENU', label: 'Ver menú' } };
    expect(extractPrimaryProductId(plan)).toBeNull();
  });
});
