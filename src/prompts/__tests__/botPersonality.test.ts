import { describe, expect, it } from 'vitest';
import {
  BOT_PERSONALITY_PROMPT,
  buildHumanizeSystemPrompt,
  buildHybridAgentSystemPrompt,
} from '../botPersonality';

describe('botPersonality', () => {
  it('incluye la personalidad compartida en humanize y hybrid', () => {
    const humanize = buildHumanizeSystemPrompt();
    const hybrid = buildHybridAgentSystemPrompt();

    expect(humanize).toContain(BOT_PERSONALITY_PROMPT);
    expect(hybrid).toContain(BOT_PERSONALITY_PROMPT);
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
});
