/**
 * Atajos tipables del Owner Assistant.
 * El backend arma las viñetas (como el carrito); el LLM no inventa la lista.
 * La interpretación del tipable la hace el ReAct al turno siguiente (sin regex pre-agente).
 */

import {
  buildShortcutsThenListBody,
  shortcutBullet,
} from '../../whatsappBuilders/listShortcutsBody';
import {
  formatBotUserMessage,
  parseBotUserMessage,
} from '../productQuery/utils';

export type OwnerShortcutActionId =
  | 'resumen'
  | 'ventas'
  | 'pedidos'
  | 'ticket'
  | 'mas_vendido'
  | 'cancelaciones'
  | 'atencion'
  | 'cola';

export type OwnerShortcutDef = {
  id: OwnerShortcutActionId;
  /** Palabra clave tipable en negrita. */
  key: string;
  /** Texto después de la clave (opcional). */
  rest?: string;
  priority: number;
  /** Tool que cubre esta acción cuando ya se invocó en el turno. */
  coveredByTool: 'get_owner_briefing' | 'get_live_orders';
};

/** Catálogo fijo, orden de prioridad (menor = primero). */
export const OWNER_SHORTCUT_CATALOG: OwnerShortcutDef[] = [
  { id: 'resumen', key: 'Resumen', rest: 'del día', priority: 1, coveredByTool: 'get_owner_briefing' },
  { id: 'ventas', key: 'Ventas', priority: 2, coveredByTool: 'get_owner_briefing' },
  { id: 'pedidos', key: 'Pedidos', priority: 3, coveredByTool: 'get_owner_briefing' },
  { id: 'ticket', key: 'Ticket', rest: 'promedio', priority: 4, coveredByTool: 'get_owner_briefing' },
  { id: 'mas_vendido', key: 'Más vendido', priority: 5, coveredByTool: 'get_owner_briefing' },
  { id: 'cancelaciones', key: 'Cancelaciones', priority: 6, coveredByTool: 'get_owner_briefing' },
  { id: 'atencion', key: 'Atención', priority: 7, coveredByTool: 'get_owner_briefing' },
  { id: 'cola', key: 'Cola', rest: 'ahora', priority: 8, coveredByTool: 'get_live_orders' },
];

const MAX_REMAINING_SHORTCUTS = 6;

export type OwnerToolInvocation = {
  name: string;
  args?: Record<string, unknown>;
};

/** Acciones ya cubiertas por las tools invocadas en el turno. */
export function resolveUsedOwnerShortcutIds(
  invocations: OwnerToolInvocation[]
): Set<OwnerShortcutActionId> {
  const used = new Set<OwnerShortcutActionId>();
  for (const inv of invocations) {
    if (inv.name === 'get_owner_briefing') {
      for (const item of OWNER_SHORTCUT_CATALOG) {
        if (item.coveredByTool === 'get_owner_briefing') used.add(item.id);
      }
    }
    if (inv.name === 'get_live_orders') {
      used.add('cola');
    }
  }
  return used;
}

export function buildOwnerShortcutsBody(options: {
  usedActionIds: Set<OwnerShortcutActionId>;
  /** Sin tools / ambigüedad: menú completo. Con consulta: restantes. */
  mode: 'menu' | 'remaining';
}): string {
  const remaining = OWNER_SHORTCUT_CATALOG.filter(
    (item) => !options.usedActionIds.has(item.id)
  ).sort((a, b) => a.priority - b.priority);

  // Menú completo siempre; en follow-up limitamos para no saturar WhatsApp.
  const shown =
    options.mode === 'menu'
      ? remaining
      : remaining.slice(0, MAX_REMAINING_SHORTCUTS);

  if (shown.length === 0) return '';

  const intro =
    options.mode === 'menu'
      ? 'Podés consultar:'
      : 'También podés:';

  const bullets = shown.map((item) =>
    shortcutBullet(item.key, item.rest ?? '')
  );
  return buildShortcutsThenListBody(intro, bullets);
}

/** Texto de menú completo (ambigüedad / error / sin tools). */
export function buildOwnerAmbiguityFallbackBody(): string {
  const shortcuts = buildOwnerShortcutsBody({
    usedActionIds: new Set(),
    mode: 'menu',
  });
  return [
    'Decime qué querés ver del local, o elegí un atajo:',
    '',
    shortcuts,
  ].join('\n');
}

export function appendOwnerShortcutsToMessage(
  message: string,
  shortcutsBody: string
): string {
  const block = shortcutsBody.trim();
  if (!block) return message;

  const parsed = parseBotUserMessage(message);
  if (parsed) {
    const body = parsed.body.trim()
      ? `${parsed.body.trim()}\n\n${block}`
      : block;
    return formatBotUserMessage(parsed.title, parsed.emoji, body);
  }
  return `${message.trim()}\n\n${block}`;
}

/** Extrae invocaciones de tools desde el hilo LangChain del turno. */
export function extractOwnerToolInvocations(
  messages: unknown[]
): OwnerToolInvocation[] {
  const out: OwnerToolInvocation[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const record = msg as Record<string, unknown>;

    const candidates: unknown[] = [];
    if (Array.isArray(record.tool_calls)) candidates.push(...record.tool_calls);
    const additional = record.additional_kwargs;
    if (additional && typeof additional === 'object') {
      const tc = (additional as { tool_calls?: unknown }).tool_calls;
      if (Array.isArray(tc)) candidates.push(...tc);
    }
    const kwargs = record.kwargs;
    if (kwargs && typeof kwargs === 'object') {
      const tc = (kwargs as { tool_calls?: unknown }).tool_calls;
      if (Array.isArray(tc)) candidates.push(...tc);
    }

    for (const raw of candidates) {
      if (!raw || typeof raw !== 'object') continue;
      const tc = raw as Record<string, unknown>;
      const fn = tc.function;
      const nameFromFn =
        fn && typeof fn === 'object'
          ? String((fn as { name?: unknown }).name ?? '')
          : '';
      const name = String(tc.name ?? nameFromFn ?? '').trim();
      if (!name) continue;

      let args: Record<string, unknown> = {};
      if (tc.args && typeof tc.args === 'object' && !Array.isArray(tc.args)) {
        args = tc.args as Record<string, unknown>;
      } else if (
        fn &&
        typeof fn === 'object' &&
        typeof (fn as { arguments?: unknown }).arguments === 'string'
      ) {
        try {
          args = JSON.parse(
            (fn as { arguments: string }).arguments
          ) as Record<string, unknown>;
        } catch {
          args = {};
        }
      }
      out.push({ name, args });
    }
  }

  return out;
}

/** Líneas para [ESTADO DEL OWNER]: tipables conocidos (sin interpretar prosa). */
export function buildOwnerShortcutLedgerLines(): string[] {
  return [
    '- Atajos tipables (si el dueño escribe uno, llamá la tool; el sistema lista atajos al final del mensaje):',
    ...OWNER_SHORTCUT_CATALOG.map(
      (item) =>
        `  • ${item.key}${item.rest ? ` ${item.rest}` : ''} → ${
          item.coveredByTool === 'get_live_orders'
            ? 'get_live_orders'
            : 'get_owner_briefing'
        }`
    ),
  ];
}
