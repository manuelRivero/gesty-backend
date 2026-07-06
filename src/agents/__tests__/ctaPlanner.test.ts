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
  listedProductNames: [],
  ...overrides,
});

/** Contenido de los mensajes pasados al LLM: [system, user]. */
const messagesFrom = (
  invokeMock: ReturnType<typeof vi.fn>
): { system: string; user: string } => {
  const messages = invokeMock.mock.calls[0]?.[0] as Array<{ content: string }>;
  return { system: messages[0].content, user: messages[1].content };
};

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

  it('acepta primaryKind=SELECT_FROM_LIST con productHints', async () => {
    mockLlm(
      JSON.stringify({
        shouldShowCta: true,
        productHint: null,
        productHints: ['Ceviche Clásico', 'Ceviche Mixto', 'Ceviche de Camarones'],
        primaryKind: 'SELECT_FROM_LIST',
        primaryLabel: 'Elegir uno 👇',
        secondaryKind: 'VIEW_MENU',
        secondaryLabel: 'Ver menú',
      })
    );

    const result = await planCta(baseInput());

    expect(result).not.toBeNull();
    expect(result!.primaryKind).toBe('SELECT_FROM_LIST');
    expect(result!.productHints).toEqual([
      'Ceviche Clásico',
      'Ceviche Mixto',
      'Ceviche de Camarones',
    ]);
  });

  it('inyecta el bloque [PRODUCTOS_LISTADOS] en el prompt cuando el agente listó productos', async () => {
    const invokeMock = mockLlm(
      JSON.stringify({
        shouldShowCta: true,
        productHint: null,
        productHints: ['Ceviche Clásico', 'Ceviche Mixto', 'Ceviche de Camarones'],
        primaryKind: 'SELECT_FROM_LIST',
        primaryLabel: 'Elegir uno 👇',
        secondaryKind: 'VIEW_MENU',
        secondaryLabel: 'Ver menú',
      })
    );

    await planCta(
      baseInput({
        listedProductNames: [
          'Ceviche Clásico',
          'Ceviche Mixto',
          'Ceviche de Camarones',
        ],
      })
    );

    const { system, user } = messagesFrom(invokeMock);
    // El bloque con los nombres exactos llega al LLM en el mensaje de usuario…
    expect(user).toContain(
      '[PRODUCTOS_LISTADOS]: Ceviche Clásico, Ceviche Mixto, Ceviche de Camarones'
    );
    // …y la regla autoritativa vive en el system prompt.
    expect(system).toContain('SEÑAL AUTORITATIVA');
  });

  it('no inyecta [PRODUCTOS_LISTADOS] cuando el agente no listó productos', async () => {
    const invokeMock = mockLlm(
      JSON.stringify({
        shouldShowCta: true,
        productHint: 'ceviche',
        primaryKind: 'ADD_ITEM',
        primaryLabel: 'Agregar 🛒',
        secondaryKind: 'VIEW_FEATURED',
        secondaryLabel: 'Ver destacados',
      })
    );

    await planCta(baseInput({ listedProductNames: [] }));

    // El mensaje de usuario no debe traer el bloque (la regla en system sí existe).
    expect(messagesFrom(invokeMock).user).not.toContain('[PRODUCTOS_LISTADOS]');
  });

  it('SELECT_FROM_LIST sin productHints sigue siendo válido (resolver hace fallback)', async () => {
    mockLlm(
      JSON.stringify({
        shouldShowCta: true,
        productHint: null,
        primaryKind: 'SELECT_FROM_LIST',
        primaryLabel: 'Elegir uno',
        secondaryKind: null,
        secondaryLabel: null,
      })
    );

    const result = await planCta(baseInput());

    expect(result).not.toBeNull();
    expect(result!.primaryKind).toBe('SELECT_FROM_LIST');
    expect(result!.productHints ?? null).toBeNull();
  });
});
