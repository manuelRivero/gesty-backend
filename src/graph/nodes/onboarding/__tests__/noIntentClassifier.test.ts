/**
 * Guardia de norma (PLAN-ACCION-NLP-AGENT-FIRST §9, `hybrid-pending-autonomy.mdc`):
 * ningún nodo de sesión clasifica el mensaje del cliente antes del ReAct.
 *
 * Salir del onboarding por cambio de tema es `finish_onboarding(not_needed)`;
 * la pregunta lateral es `delegate_to_main`. Un clasificador pre-ReAct colapsa
 * esas dos salidas y, al escribir refusals, deja el onboarding cerrado para
 * siempre en esa conversación.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string): string =>
  readFileSync(join(__dirname, relativePath), 'utf8');

describe('nodos de sesión — sin clasificador de intent pre-ReAct', () => {
  it.each([
    ['onboarding', '../index.ts'],
    ['delegated address confirmation', '../../session/delegatedAddressConfirmation.ts'],
    ['delegate to main', '../../session/delegateToMain.ts'],
  ])('%s no llama detectIntentWithConfidence', (_name, path) => {
    const source = readSource(path);
    expect(source).not.toMatch(/detectIntentWithConfidence\s*\(/);
  });

  it('el onboarding no tiene catálogo de intents que libere la sesión', () => {
    const source = readSource('../index.ts');
    expect(source).not.toMatch(/SKIP_ADDRESS_INTENTS/);
    expect(source).not.toMatch(/ConversationIntent\./);
  });
});
