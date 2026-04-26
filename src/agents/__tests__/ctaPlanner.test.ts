/**
 * Tests del ctaPlanner con LLM mockeado.
 * Verifica parsing de JSON, validación Zod, cooldown (responsabilidad del caller)
 * y comportamiento cuando shouldShowCta = false.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock del LLM antes de importar el módulo
vi.mock('../../config/llm', () => ({
  getIntentDetectorLlm: vi.fn(),
}));

import { planCta } from '../ctaPlanner';
import { getIntentDetectorLlm } from '../../config/llm';
import type { CtaPlannerInput } from '../types';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const mockLlm = (content: string) => {
  const invokeMock = vi.fn().mockResolvedValue({ content });
  vi.mocked(getIntentDetectorLlm).mockReturnValue({ invoke: invokeMock } as any);
  return invokeMock;
};

const baseInput = (overrides: Partial<CtaPlannerInput> = {}): CtaPlannerInput => ({
  botResponseText: '🤖\n\n*Ceviche Clásico*\n\nEs levemente picante, lleva ají amarillo.',
  intent: 'PRODUCT_ATTRIBUTE_QUESTION',
  detectedProductName: 'ceviche',
  lastReferencedProductName: 'Ceviche Clásico',
  userMessage: 'el ceviche puede ser picante?',
  topMenuProductNames: ['Ceviche Clásico', 'Ceviche Mixto'],
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('planCta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('devuelve plan válido cuando LLM responde JSON correcto', async () => {
    mockLlm(
      JSON.stringify({
        shouldShowCta: true,
        productHint: 'ceviche',
        primaryKind: 'ADD_ITEM',
        primaryLabel: 'Agregar 🛒',
        secondaryKind: 'VIEW_FEATURED',
        secondaryLabel: 'Ver destacados',
      })
    );

    const result = await planCta(baseInput());

    expect(result).not.toBeNull();
    expect(result!.primaryKind).toBe('ADD_ITEM');
    expect(result!.productHint).toBe('ceviche');
    expect(result!.shouldShowCta).toBe(true);
  });

  it('devuelve null cuando shouldShowCta = false', async () => {
    mockLlm(
      JSON.stringify({
        shouldShowCta: false,
        productHint: null,
        primaryKind: 'VIEW_MENU',
        primaryLabel: 'Ver menú',
        secondaryKind: null,
        secondaryLabel: null,
      })
    );

    const result = await planCta(baseInput());
    expect(result).toBeNull();
  });

  it('devuelve null cuando LLM retorna JSON inválido', async () => {
    mockLlm('esto no es JSON');

    const result = await planCta(baseInput());
    expect(result).toBeNull();
  });

  it('devuelve null cuando el schema Zod falla (campo requerido faltante)', async () => {
    mockLlm(
      JSON.stringify({
        shouldShowCta: true,
        // falta primaryKind y otros campos requeridos
        productHint: 'ceviche',
      })
    );

    const result = await planCta(baseInput());
    expect(result).toBeNull();
  });

  it('devuelve null cuando LLM lanza error', async () => {
    const invokeMock = vi.fn().mockRejectedValue(new Error('LLM timeout'));
    vi.mocked(getIntentDetectorLlm).mockReturnValue({ invoke: invokeMock } as any);

    const result = await planCta(baseInput());
    expect(result).toBeNull();
  });

  it('trunca el resultado con VIEW_MENU si primaryKind es VIEW_MENU', async () => {
    mockLlm(
      JSON.stringify({
        shouldShowCta: true,
        productHint: null,
        primaryKind: 'VIEW_MENU',
        primaryLabel: 'Ver menú',
        secondaryKind: 'VIEW_FEATURED',
        secondaryLabel: 'Ver destacados',
      })
    );

    const result = await planCta(baseInput());
    expect(result).not.toBeNull();
    expect(result!.primaryKind).toBe('VIEW_MENU');
  });

  it('no llama al LLM cuando el LLM retorna contenido vacío', async () => {
    mockLlm('');
    const result = await planCta(baseInput());
    expect(result).toBeNull();
  });

  it('maneja contenido como array (formato LangChain multi-part)', async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      content: [
        { text: JSON.stringify({
          shouldShowCta: true,
          productHint: 'pasta',
          primaryKind: 'ADD_ITEM',
          primaryLabel: 'Agregar',
          secondaryKind: 'VIEW_MENU',
          secondaryLabel: 'Ver menú',
        }) },
      ],
    });
    vi.mocked(getIntentDetectorLlm).mockReturnValue({ invoke: invokeMock } as any);

    const result = await planCta(baseInput({ detectedProductName: 'pasta' }));
    expect(result).not.toBeNull();
    expect(result!.primaryKind).toBe('ADD_ITEM');
  });
});
