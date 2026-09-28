import { ToolMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import type { RunnableConfig } from '@langchain/core/runnables';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { prisma } from '../lib/prisma';
import { getHumanIntentState, type HumanIntentRecord } from '../services/humanIntentState.service';

const normalizeTarget = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const matchesPhrase = (candidate: string, requestValue: string): boolean => {
  const target = normalizeTarget(candidate);
  const request = normalizeTarget(requestValue);
  if (!target || !request) return false;
  if (target === request) return true;
  return target.startsWith(`${request} `) || target.endsWith(` ${request}`);
};

const collectRequestTargets = (value: unknown, key = ''): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectRequestTargets(item, key));
  }
  if (typeof value === 'string') {
    return /product|plato|dish|category|categoria|tag|keyword|query|ingredient|producto|target/i.test(key)
      ? [value]
      : [];
  }
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([childKey, child]) =>
    collectRequestTargets(child, childKey)
  );
};

const resolveMenuItemName = async (businessId: string, productId: string): Promise<string | null> => {
  const row = await prisma.menu_item.findFirst({
    where: { id: productId, business_id: businessId },
    select: { name: true },
  });
  return row?.name ?? null;
};

const resolveCategoryName = async (businessId: string, categoryId: string): Promise<string | null> => {
  const row = await prisma.menu_category.findFirst({
    where: { id: categoryId, business_id: businessId },
    select: { name: true },
  });
  return row?.name ?? null;
};

const stringArray = (value: unknown): string[] => {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }
  return [];
};

const toolTargets = async (
  name: string,
  rawArgs: unknown,
  businessId: string
): Promise<string[] | null> => {
  if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) return null;
  const args = rawArgs as Record<string, unknown>;
  switch (name) {
    case 'search_products':
    case 'suggest_dishes_for_party_size':
      return stringArray(args.keyword);
    case 'find_products_by_filter':
      {
        const targets = [
        ...stringArray(args.categoryTag),
        ...stringArray(args.containsIngredient),
        ...stringArray(args.excludesIngredient),
        ];
        if (typeof args.categoryId === 'string') {
          const category = await resolveCategoryName(businessId, args.categoryId);
          if (category) targets.push(category);
        }
        return targets.length > 0 ? targets : null;
      }
    case 'present_category':
    case 'get_menu_by_category': {
      const id = typeof args.categoryId === 'string' ? args.categoryId : null;
      if (!id) return null;
      const nameValue = await resolveCategoryName(businessId, id);
      return nameValue ? [nameValue] : null;
    }
    case 'add_cart_item':
    case 'check_product_availability': {
      const nameValue = typeof args.productName === 'string' ? args.productName : null;
      if (nameValue) return [nameValue];
      const id = typeof args.productId === 'string' ? args.productId : null;
      if (!id) return null;
      const productName = await resolveMenuItemName(businessId, id);
      return productName ? [productName] : null;
    }
    case 'cancel_order':
      return stringArray(args.target);
    case 'get_products_details_by_ids': {
      const ids = stringArray(args.productIds);
      if (ids.length === 0) return null;
      const rows = await prisma.menu_item.findMany({
        where: { id: { in: ids }, business_id: businessId },
        select: { name: true },
      });
      return rows.map((row) => row.name);
    }
    case 'present_product_cta': {
      const labels = [
        ...stringArray(args.productHint),
        ...stringArray(args.productHints),
      ];
      const ids = [
        ...stringArray(args.productId),
        ...stringArray(args.productIds),
      ];
      if (ids.length > 0) {
        const rows = await prisma.menu_item.findMany({
          where: { id: { in: ids }, business_id: businessId },
          select: { name: true },
        });
        labels.push(...rows.map((row) => row.name));
      }
      return labels.length > 0 ? labels : null;
    }
    default:
      return null;
  }
};

const matchesIntent = (intent: HumanIntentRecord, targets: string[]): boolean => {
  const requestTargets = collectRequestTargets(intent.request);
  return requestTargets.some((requestTarget) =>
    targets.some((target) => matchesPhrase(target, requestTarget))
  );
};

export const HUMAN_INTENT_TOOL_DENIED = 'human_intent_pending_tool_denied';
export const HUMAN_INTENT_STATE_STALE = 'human_intent_state_stale';
export const HUMAN_INTENT_STATE_UNAVAILABLE = 'human_intent_state_unavailable';

const internalToolError = (call: ToolCall, code: string, intentId?: string): ToolMessage =>
  new ToolMessage({
    name: call.name,
    tool_call_id: call.id ?? '',
    status: 'error',
    content: JSON.stringify({
      error: code,
      ...(intentId ? { pendingIntentId: intentId } : {}),
      instruction: 'No ejecutes esta intención pendiente en este turno. Continuá exclusivamente con ACTIVE.',
    }),
  });

export class HumanIntentToolNode extends ToolNode {
  protected override async runTool(call: ToolCall, config: RunnableConfig) {
    const configurable = config.configurable as
      | { conversationId?: unknown; businessId?: unknown; humanIntentGateRevision?: unknown }
      | undefined;
    const conversationId = configurable?.conversationId;
    const businessId = configurable?.businessId;
    const expectedRevision = configurable?.humanIntentGateRevision;

    // Handoffs and legacy direct invocations do not carry a preflight revision.
    if (
      typeof conversationId !== 'string' ||
      typeof businessId !== 'string' ||
      typeof expectedRevision !== 'number'
    ) {
      return super.runTool(call, config);
    }

    let state;
    try {
      state = await getHumanIntentState(conversationId);
    } catch {
      return internalToolError(call, HUMAN_INTENT_STATE_UNAVAILABLE);
    }

    if (state.revision !== expectedRevision) {
      return internalToolError(call, HUMAN_INTENT_STATE_STALE);
    }

    const active = state.records.find((intent) => intent.status === 'ACTIVE');
    const pending = state.records.filter((intent) => intent.status === 'PENDING');
    if (!active || pending.length === 0) return super.runTool(call, config);

    try {
      const targets = await toolTargets(call.name, call.args, businessId);
      if (!targets || targets.length === 0) return super.runTool(call, config);

      const pendingMatch = pending.find((intent) => matchesIntent(intent, targets));
      if (!pendingMatch || matchesIntent(active, targets)) return super.runTool(call, config);
      return internalToolError(call, HUMAN_INTENT_TOOL_DENIED, pendingMatch.id);
    } catch {
      // A target that cannot be resolved is not clearly attributable to PENDING.
      return super.runTool(call, config);
    }
  }
}