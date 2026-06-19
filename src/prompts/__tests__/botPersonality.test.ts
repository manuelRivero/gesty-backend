import { describe, expect, it } from 'vitest';
import {
  BOT_PERSONALITY_PROMPT,
  buildHumanizeSystemPrompt,
  buildHybridAgentSystemPrompt,
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

  it('humanize pide solo el cuerpo reescrito', () => {
    expect(buildHumanizeSystemPrompt()).toMatch(/SOLO el cuerpo/i);
  });

  it('hybrid incluye reglas operativas de tools', () => {
    expect(buildHybridAgentSystemPrompt()).toMatch(/search_products/i);
    expect(buildHybridAgentSystemPrompt()).toMatch(/ANTI-MULTI-PRODUCTO/i);
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
