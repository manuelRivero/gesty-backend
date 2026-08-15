/**
 * Wipe del cliente de prueba Manuel (WhatsApp 5493413867990).
 * Borra customer + conversaciones + drafts + pedidos/reservas/comprobantes
 * para que el próximo mensaje arranque limpio y el agente no quede
 * atrapado en onboarding (`onboarding_agent_active` / direcciones / state).
 * Al borrar customer + conversations (+ cascade `conversation_state`), también
 * limpia el ledger de refusal `OBTENER_DIRECCION` y `OBTENER_NOMBRE` — el
 * próximo mensaje arranca como cliente nuevo (refusal 0 → Ownership por Facts
 * si falta dirección o nombre).
 *
 * Uso:
 *   npx tsx scripts/wipe-manuel.ts           # dry-run (solo lista)
 *   npx tsx scripts/wipe-manuel.ts --execute # borra de verdad
 *
 * Delega en wipe-customer-data.ts (mismo alcance y variantes de teléfono).
 */
import { spawnSync } from 'node:child_process';

const PHONE = '5493413867990';
const LABEL = 'manuel';
const execute = process.argv.includes('--execute');

console.log(`[wipe-manuel] cliente=${LABEL} phone=${PHONE}`);
console.log(`[wipe-manuel] modo=${execute ? 'EXECUTE' : 'DRY-RUN'}`);

const result = spawnSync(
  'npx',
  ['tsx', 'scripts/wipe-customer-data.ts', PHONE, ...(execute ? ['--execute'] : [])],
  { stdio: 'inherit', env: process.env },
);

process.exit(result.status ?? 1);
