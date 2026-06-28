/**
 * Ofusca el resultado del build (dist/) in-place.
 *
 * - Solo toca archivos .js de NUESTRO dist/, nunca node_modules ni el cliente
 *   Prisma generado.
 * - Configuración "moderada": renombrado de identificadores + stringArray en
 *   base64. Se evitan controlFlowFlattening pesado, selfDefending y
 *   debugProtection porque en apps Node con Express/Prisma/LangChain degradan
 *   el rendimiento y pueden romper en runtime.
 *
 * Uso: node scripts/obfuscate.mjs [distDir]
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JavaScriptObfuscator from 'javascript-obfuscator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '..', process.argv[2] ?? 'dist');

/** @type {import('javascript-obfuscator').ObfuscatorOptions} */
const OPTIONS = {
  compact: true,
  simplify: true,
  target: 'node',

  // Renombrado de identificadores locales (no globales, para no romper exports/requires).
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,

  // Ofuscación de strings.
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  splitStrings: true,
  splitStringsChunkLength: 10,

  // Desactivado a propósito (estabilidad / performance en Node).
  controlFlowFlattening: false,
  deadCodeInjection: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,

  // Mantener números legibles complica un poco; los transformamos.
  numbersToExpressions: true,

  // No reservar nada especial: solo ofuscamos código propio ya compilado.
  reservedStrings: [],
};

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && full.endsWith('.js')) {
      yield full;
    }
  }
}

async function main() {
  let count = 0;
  for await (const file of walk(DIST_DIR)) {
    const code = await readFile(file, 'utf8');
    const result = JavaScriptObfuscator.obfuscate(code, OPTIONS).getObfuscatedCode();
    await writeFile(file, result, 'utf8');
    count += 1;
  }
  console.log(`[obfuscate] ${count} archivo(s) ofuscado(s) en ${DIST_DIR}`);
}

main().catch((err) => {
  console.error('[obfuscate] error:', err);
  process.exit(1);
});
