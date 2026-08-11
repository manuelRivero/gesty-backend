import { describe, expect, it } from 'vitest';
import {
  BOT_PERSONALITY_PROMPT,
  buildComplementarySuggestionSystemPrompt,
  buildHumanizeSystemPrompt,
  buildHybridAgentSystemPrompt,
  buildProductAwareSystemPrompt,
} from '../botPersonality';

const FRIENDLY_PROMPT = 'PERSONALIDAD AMIGUERA DE PRUEBA';

describe('botPersonality', () => {
  it('incluye la personalidad compartida en humanize y hybrid por defecto', () => {
    const humanize = buildHumanizeSystemPrompt();
    const hybrid = buildHybridAgentSystemPrompt();

    expect(humanize).toContain(BOT_PERSONALITY_PROMPT);
    expect(hybrid).toContain(BOT_PERSONALITY_PROMPT);
  });

  it('inyecta el bloque de personalidad provisto desde BD', () => {
    const humanize = buildHumanizeSystemPrompt(FRIENDLY_PROMPT);
    const hybrid = buildHybridAgentSystemPrompt(FRIENDLY_PROMPT);

    expect(humanize).toContain(FRIENDLY_PROMPT);
    expect(hybrid).toContain(FRIENDLY_PROMPT);
    expect(humanize).not.toContain(BOT_PERSONALITY_PROMPT);
  });

  it('humanize pide solo el cuerpo reescrito y preservar estructura', () => {
    const humanize = buildHumanizeSystemPrompt();
    expect(humanize).toMatch(/SOLO cambiar el tono/i);
    expect(humanize).toMatch(/Estructura sagrada/i);
    expect(humanize).toMatch(/viñetas/i);
    expect(humanize).toMatch(/negrita/i);
    expect(humanize).toMatch(/NO agregues un segundo par/i);
  });

  it('hybrid menciona tipables ITEM_NOTE / prioridad gestión', () => {
    const hybrid = buildHybridAgentSystemPrompt();
    expect(hybrid).toMatch(/ITEM_NOTE|nota del pedido/i);
    expect(hybrid).toMatch(/la papa con poca sal/i);
    expect(hybrid).toMatch(/NO fuerces add/i);
  });

  it('hybrid incluye reglas operativas de tools', () => {
    const hybrid = buildHybridAgentSystemPrompt();
    expect(hybrid).toMatch(/search_products/i);
    expect(hybrid).toMatch(/ANTI-MULTI-PRODUCTO/i);
    expect(hybrid).toMatch(/present_category/i);
    expect(hybrid).toMatch(/CATEGORÍA POR TEXTO LIBRE/i);
  });

  it('hybrid permite present_complement_suggestions tras add sin forzar present_cart', () => {
    const hybrid = buildHybridAgentSystemPrompt();
    expect(hybrid).toMatch(/present_complement_suggestions/i);
    expect(hybrid).toMatch(/No llames ambas en el mismo turno/i);
    expect(hybrid).toMatch(/PROHIBIDO \(upsell vacío\)/i);
    expect(hybrid).toMatch(/Sugerir sin esta tool está prohibido/i);
    expect(hybrid).toMatch(/opportunity.*nextAction|nextAction present_complement/i);
    expect(hybrid).toMatch(/La lista ya confirma el add/i);
  });

  it('hybrid instruye a resolver Selección de producto pendiente contra candidatos', () => {
    const hybrid = buildHybridAgentSystemPrompt();
    expect(hybrid).toMatch(/SELECCIÓN PENDIENTE/i);
    expect(hybrid).toMatch(/Selección de producto pendiente/i);
  });

  it('complementary prompt pide intro corta sin listar platos', () => {
    const prompt = buildComplementarySuggestionSystemPrompt();
    expect(prompt).toMatch(/"skip"\s*:\s*true/);
    expect(prompt).toMatch(/omitir/i);
    expect(prompt).toMatch(/1 a 2 oraciones/i);
    expect(prompt).toMatch(/No listes platos/i);
  });

  it('hybrid ANTI-MULTI-PRODUCTO prohíbe listar platos/porciones/precios en prosa', () => {
    const hybrid = buildHybridAgentSystemPrompt();
    expect(hybrid).toMatch(/ANTI-MULTI-PRODUCTO/i);
    expect(hybrid).toMatch(/PROHIBIDO en tu texto/i);
    expect(hybrid).toMatch(/porciones y precio/i);
  });

  it('hybrid incluye cancel_order para cancelación real', () => {
    const hybrid = buildHybridAgentSystemPrompt();
    expect(hybrid).toMatch(/cancel_order/i);
    expect(hybrid).toMatch(/CANCELAR PEDIDO/i);
  });

  it('hybrid declara el bloque de estado como contexto interno no narrable', () => {
    const hybrid = buildHybridAgentSystemPrompt();
    expect(hybrid).toMatch(/ESTADO DEL CLIENTE ES CONTEXTO INTERNO/i);
    expect(hybrid).toMatch(/NUNCA se parafrasea/i);
    expect(hybrid).toMatch(/no lo repitas/i);
  });

  it('hybrid incluye get_popular_products y la regla de no inventar ranking', () => {
    const hybrid = buildHybridAgentSystemPrompt();
    expect(hybrid).toMatch(/get_popular_products/i);
    expect(hybrid).toMatch(/significant/i);
    expect(hybrid).toMatch(/no inventes un ranking/i);
  });

  it('product-aware prohíbe negar variaciones sin revisar la lista', () => {
    const prompt = buildProductAwareSystemPrompt();
    expect(prompt).toMatch(/Variaciones disponibles/i);
    expect(prompt).toMatch(/Nunca afirmes que no existe una variedad/i);
  });

  it('desalienta frases plantilla robóticas', () => {
    expect(BOT_PERSONALITY_PROMPT).toMatch(/Tenemos varias opciones de X disponibles/i);
  });

  it('incluye atributos estilo Meta Business Agent', () => {
    expect(BOT_PERSONALITY_PROMPT).toMatch(/Meta Business Agent/i);
    expect(BOT_PERSONALITY_PROMPT).toMatch(/Empático y presente/i);
    expect(BOT_PERSONALITY_PROMPT).toMatch(/Proactivo pero no invasivo/i);
  });
});
