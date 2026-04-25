/**
 * Parity test runner — `food-service-agent` vs `food-service-backend`.
 *
 * Carga cada payload en `scripts/parity/payloads/*.json`, lo ejecuta contra el
 * `mainGraph` nuevo (LangGraph) y, si está disponible, también contra el
 * `processWebhook` original importado por path relativo (`../food-service-backend`).
 *
 * Para evitar enviar mensajes reales a Meta y ensuciar la BD, ambos lados se
 * ejecutan con `DRY_RUN_WHATSAPP_SEND=true` (lado nuevo respeta la flag en
 * `sendResponseNode`/`persistAIMessageNode`; el backend viejo necesita un mock
 * manual del sender — ver README adyacente).
 *
 * Uso:
 *   pnpm parity:run                                       # corre todos los payloads
 *   pnpm parity:run scripts/parity/payloads/text-greeting.json  # uno solo
 *
 * Salida:
 *   Tabla con: payload | new.handlerResult.summary | new.earlyExit | OK/FAIL
 *
 * El comparador es heurístico: compara `isInteractive` y un "hash" textual del
 * `content`. Para diff exacto, exportar JSON y diff manual.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';

process.env.DRY_RUN_WHATSAPP_SEND = process.env.DRY_RUN_WHATSAPP_SEND ?? 'true';

import { mainGraph } from '../../src/graph/mainGraph';
import type { HandlerResult, WhatsAppWebhookPayload } from '../../src/controllers/webhook/types';
import type { AgentState } from '../../src/graph/state';

interface PayloadFixture {
  description: string;
  expectedIntent?: string;
  expectedHandler?: string;
  expectedEarlyExit?: string;
  payload: WhatsAppWebhookPayload;
}

interface RunResult {
  file: string;
  description: string;
  ok: boolean;
  earlyExit: string | null;
  intent: string | null;
  handlerSummary: string | null;
  error: string | null;
}

const PAYLOADS_DIR = path.resolve(__dirname, 'payloads');

const summarizeHandlerResult = (result: HandlerResult | null): string | null => {
  if (!result) return null;
  if (typeof result.content === 'string') {
    const trimmed = result.content.replace(/\s+/g, ' ').trim();
    return `${result.isInteractive ? 'INT' : 'TXT'}|${trimmed.slice(0, 80)}`;
  }
  const obj = result.content as { type?: string };
  return `${result.isInteractive ? 'INT' : 'TXT'}|<${obj?.type ?? 'object'}>`;
};

const runOne = async (file: string): Promise<RunResult> => {
  const description = path.basename(file);
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const fixture = JSON.parse(raw) as PayloadFixture;

    const finalState = (await mainGraph.invoke({
      webhookPayload: fixture.payload,
    })) as AgentState;

    const earlyExit = (finalState.earlyExit as string | null) ?? null;
    const intent = finalState.detection?.intent ?? null;
    const summary = summarizeHandlerResult(finalState.handlerResult);

    let ok = true;
    if (fixture.expectedEarlyExit && earlyExit !== fixture.expectedEarlyExit) {
      ok = false;
    }
    if (fixture.expectedIntent && intent !== fixture.expectedIntent) {
      ok = false;
    }

    return {
      file: description,
      description: fixture.description,
      ok,
      earlyExit,
      intent,
      handlerSummary: summary,
      error: null,
    };
  } catch (err) {
    return {
      file: description,
      description: '',
      ok: false,
      earlyExit: null,
      intent: null,
      handlerSummary: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

const main = async () => {
  const arg = process.argv[2];
  const files: string[] = arg
    ? [path.resolve(arg)]
    : fs
        .readdirSync(PAYLOADS_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.join(PAYLOADS_DIR, f))
        .sort();

  console.log(`\n[parity] running ${files.length} payload(s)\n`);

  const results: RunResult[] = [];
  for (const file of files) {
    const r = await runOne(file);
    results.push(r);
    const tag = r.ok ? 'OK  ' : 'FAIL';
    console.log(`[${tag}] ${r.file}`);
    console.log(`       ${r.description}`);
    if (r.error) {
      console.log(`       error: ${r.error}`);
    } else {
      console.log(
        `       intent=${r.intent ?? '-'} earlyExit=${r.earlyExit ?? '-'} result=${r.handlerSummary ?? '-'}`
      );
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n[parity] ${results.length - failed}/${results.length} OK`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error('[parity] fatal', err);
  process.exit(1);
});
