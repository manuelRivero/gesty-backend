/**
 * Tests unitarios para ctaResolver.
 *
 * MenuService.searchMenuItemsByKeyword y prisma se mockean para no requerir BD.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks declarados antes de los imports de los módulos bajo test
vi.mock('../../services/menu.service', () => ({
  MenuService: {
    searchMenuItemsByKeyword: vi.fn(),
  },
}));

vi.mock('../../lib/prisma', () => ({
  prisma: {
    menu_item: {
      findUnique: vi.fn(),
    },
  },
}));

import { resolveCta, hasLexicalBuySignal } from '../ctaResolver';
import { MenuService } from '../../services/menu.service';
import { prisma } from '../../lib/prisma';
import type { CtaPlannerRaw, CtaResolverInput } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const basePlannerRaw = (overrides: Partial<CtaPlannerRaw> = {}): CtaPlannerRaw => ({
  shouldShowCta: true,
  productHint: null,
  primaryKind: 'ADD_ITEM',
  primaryLabel: 'Agregar 🛒',
  secondaryKind: 'VIEW_FEATURED',
  secondaryLabel: 'Ver destacados',
  ...overrides,
});

const baseInput = (overrides: Partial<CtaResolverInput> = {}): CtaResolverInput => ({
  plannerRaw: basePlannerRaw(),
  businessId: 'biz-1',
  lastReferencedProductId: null,
  detectedProductName: null,
  botResponseText: '🤖\n\n*Ceviche Clásico*\n\nEs levemente picante.',
  detectionQuantity: null,
  userMessage: 'el ceviche puede ser picante?',
  ...overrides,
});

// ---------------------------------------------------------------------------
// hasLexicalBuySignal
// ---------------------------------------------------------------------------

describe('hasLexicalBuySignal', () => {
  it.each([
    ['quiero uno', true],
    ['dame ese', true],
    ['agrega al carrito', true],
    ['quiero comprar', true],
    ['para llevar', true],
    ['me podés decir si es picante', false],
    ['tenés opciones sin gluten', false],
    ['gracias!', false],
  ])('detecta señal en "%s" → %s', (msg, expected) => {
    expect(hasLexicalBuySignal(msg)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// resolveCta — VIEW_MENU / VIEW_FEATURED directo
// ---------------------------------------------------------------------------

describe('resolveCta — acciones no-transaccionales', () => {
  it('VIEW_MENU → retorna plan VIEW_MENU sin buscar en BD', async () => {
    const input = baseInput({
      plannerRaw: basePlannerRaw({ primaryKind: 'VIEW_MENU', primaryLabel: 'Ver menú' }),
    });

    const plan = await resolveCta(input);

    expect(plan.primary.kind).toBe('VIEW_MENU');
    expect(MenuService.searchMenuItemsByKeyword).not.toHaveBeenCalled();
  });

  it('VIEW_FEATURED → retorna plan VIEW_FEATURED', async () => {
    const input = baseInput({
      plannerRaw: basePlannerRaw({ primaryKind: 'VIEW_FEATURED', primaryLabel: 'Ver destacados' }),
    });

    const plan = await resolveCta(input);
    expect(plan.primary.kind).toBe('VIEW_FEATURED');
  });
});

// ---------------------------------------------------------------------------
// resolveCta — ADD_ITEM con productHint resoluble
// ---------------------------------------------------------------------------

describe('resolveCta — ADD_ITEM resolución por productHint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1 resultado → ADD_ITEM con productId correcto', async () => {
    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValue([
      {
        id: 'prod-abc',
        name: 'Ceviche Clásico',
        description: 'Con limón',
        ingredients: null,
        serves_people: 1,
        is_available: true,
        menu_item_price: [],
      },
    ]);

    const input = baseInput({
      plannerRaw: basePlannerRaw({ productHint: 'ceviche' }),
    });

    const plan = await resolveCta(input);

    expect(plan.primary.kind).toBe('ADD_ITEM');
    if (plan.primary.kind === 'ADD_ITEM') {
      expect(plan.primary.productId).toBe('prod-abc');
      expect(plan.primary.quantity).toBe(1);
    }
    expect(plan.secondary).toBeDefined();
  });

  it('2-5 resultados → SELECT_FROM_LIST', async () => {
    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValue([
      { id: 'p1', name: 'Ceviche Clásico', description: null, ingredients: null, serves_people: 1, is_available: true, menu_item_price: [] },
      { id: 'p2', name: 'Ceviche Mixto', description: null, ingredients: null, serves_people: 1, is_available: true, menu_item_price: [] },
      { id: 'p3', name: 'Ceviche de Camarones', description: null, ingredients: null, serves_people: 1, is_available: true, menu_item_price: [] },
    ]);

    const input = baseInput({
      plannerRaw: basePlannerRaw({ productHint: 'ceviche' }),
    });

    const plan = await resolveCta(input);

    expect(plan.primary.kind).toBe('SELECT_FROM_LIST');
    if (plan.primary.kind === 'SELECT_FROM_LIST') {
      expect(plan.primary.candidates.length).toBe(3);
      expect(plan.primary.candidates.map((c) => c.productId)).toContain('p1');
    }
  });

  it('>5 resultados → SELECT_FROM_LIST con máximo 5 candidatos', async () => {
    const manyResults = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      name: `Ceviche ${i}`,
      description: null,
      ingredients: null,
      serves_people: 1,
      is_available: true,
      menu_item_price: [],
    }));

    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValue(manyResults);

    const input = baseInput({
      plannerRaw: basePlannerRaw({ productHint: 'ceviche' }),
    });

    const plan = await resolveCta(input);

    expect(plan.primary.kind).toBe('SELECT_FROM_LIST');
    if (plan.primary.kind === 'SELECT_FROM_LIST') {
      expect(plan.primary.candidates.length).toBeLessThanOrEqual(5);
    }
  });

  it('0 resultados → cae a VIEW_MENU (fallback)', async () => {
    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValue([]);
    vi.mocked(prisma.menu_item.findUnique).mockResolvedValue(null);

    const input = baseInput({
      plannerRaw: basePlannerRaw({ productHint: 'producto inexistente' }),
    });

    const plan = await resolveCta(input);
    expect(plan.primary.kind).toBe('VIEW_MENU');
  });
});

// ---------------------------------------------------------------------------
// resolveCta — fallback a lastReferencedProductId
// ---------------------------------------------------------------------------

describe('resolveCta — fallback lastReferencedProductId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('usa lastReferencedProductId si productHint no resuelve', async () => {
    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValue([]);
    vi.mocked(prisma.menu_item.findUnique).mockResolvedValue({
      id: 'last-prod',
      name: 'Ceviche Clásico',
    } as any);

    const input = baseInput({
      plannerRaw: basePlannerRaw({ productHint: 'algo raro' }),
      lastReferencedProductId: 'last-prod',
    });

    const plan = await resolveCta(input);

    expect(plan.primary.kind).toBe('ADD_ITEM');
    if (plan.primary.kind === 'ADD_ITEM') {
      expect(plan.primary.productId).toBe('last-prod');
    }
  });
});

// ---------------------------------------------------------------------------
// resolveCta — señal léxica Fase 2
// ---------------------------------------------------------------------------

describe('resolveCta — señal léxica (Fase 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('señal léxica + lastReferencedProductId → ADD_ITEM directo sin buscar keyword', async () => {
    const input = baseInput({
      plannerRaw: basePlannerRaw({ productHint: null }),
      lastReferencedProductId: 'direct-prod',
      userMessage: 'quiero ese mismo',
    });

    const plan = await resolveCta(input);

    expect(plan.primary.kind).toBe('ADD_ITEM');
    if (plan.primary.kind === 'ADD_ITEM') {
      expect(plan.primary.productId).toBe('direct-prod');
    }
    expect(MenuService.searchMenuItemsByKeyword).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveCta — quantity desde detectionQuantity (Fase 2)
// ---------------------------------------------------------------------------

describe('resolveCta — quantity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('usa detectionQuantity cuando es > 1', async () => {
    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValue([
      { id: 'p1', name: 'Ceviche', description: null, ingredients: null, serves_people: 1, is_available: true, menu_item_price: [] },
    ]);

    const input = baseInput({
      plannerRaw: basePlannerRaw({ productHint: 'ceviche' }),
      detectionQuantity: 3,
    });

    const plan = await resolveCta(input);

    if (plan.primary.kind === 'ADD_ITEM') {
      expect(plan.primary.quantity).toBe(3);
    }
  });

  it('default quantity 1 cuando detectionQuantity es null', async () => {
    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValue([
      { id: 'p1', name: 'Ceviche', description: null, ingredients: null, serves_people: 1, is_available: true, menu_item_price: [] },
    ]);

    const input = baseInput({
      plannerRaw: basePlannerRaw({ productHint: 'ceviche' }),
      detectionQuantity: null,
    });

    const plan = await resolveCta(input);
    if (plan.primary.kind === 'ADD_ITEM') {
      expect(plan.primary.quantity).toBe(1);
    }
  });
});
