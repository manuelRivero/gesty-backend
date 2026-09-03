/**
 * Carga el archivo de entorno según el contexto.
 *
 * Prioridad:
 * 1. DOTENV_CONFIG_PATH (si está seteado)
 * 2. .env.development | .env.production según NODE_ENV
 * 3. .env (compatibilidad)
 *
 * Uso local:
 *   - Desarrollo:  `.env.development`  (Neon develop + Stripe test)
 *   - Producción:  `.env.production`   (solo en el server; no commitear)
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

let loadedPath: string | null = null;

export function loadEnv(): string {
  if (loadedPath) return loadedPath;

  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const byNodeEnv =
    nodeEnv === 'production' ? '.env.production' : '.env.development';

  const candidates = [
    process.env.DOTENV_CONFIG_PATH,
    byNodeEnv,
    '.env',
  ].filter((p): p is string => Boolean(p && p.trim()));

  for (const candidate of candidates) {
    const full = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(process.cwd(), candidate);
    if (fs.existsSync(full)) {
      dotenv.config({ path: full });
      loadedPath = full;
      if (process.env.DEBUG_LOAD_ENV === '1') {
        console.log(`[env] loaded ${full}`);
      }
      return full;
    }
  }

  dotenv.config();
  loadedPath = '(dotenv default)';
  return loadedPath;
}
