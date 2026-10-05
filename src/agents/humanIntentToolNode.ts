import { AIMessage, BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Command, isCommand, Send } from '@langchain/langgraph';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { getHumanIntentState, type HumanIntentRecord } from '../services/humanIntentState.service';
import { resolveProductForAdd } from '../services/productResolution.service';
import type { ProductResolution } from '../services/productResolution.service';
import { getPendingOrderLines } from '../services/pendingOrderLines.service';
import { evaluateToolRequirement } from '../services/requirementEvaluator';
import {
  partySizeRequiredPayload,
  rememberPartySizeBlockedFood,
  summarizeBlockedAdd,
} from '../services/partySizeGoal.service';
import {
  DEFAULT_TOOL_CONTRACTS,
} from './toolContracts';
import { ToolExecutor } from './toolExecutor';
import { planToolCalls } from './toolPlanner';
import { PostEffectToolNode } from './postEffectToolNode';

const uuidSchema = z.string().uuid();

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
      if (!id || !uuidSchema.safeParse(id).success) return null;
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

const PRODUCT_SEARCH_TOOLS = new Set(['search_products', 'find_products_by_filter']);

const productIdFrom = (call: ToolCall): string | null => {
  const args = call.args as Record<string, unknown>;
  return typeof args.productId === 'string' ? args.productId : null;
};

const validatedProductResolutionFor = (
  message: ToolMessage,
  call: ToolCall
): { productId: string; resolutionId?: string } | null => {
  if (message.status !== 'success' || typeof message.content !== 'string') return null;
  try {
    const result = JSON.parse(message.content) as Record<string, unknown>;
    const expectedResolutionId = (call.args as Record<string, unknown>).resolutionId;
    const valid =
      result.success === true &&
      result.productId === productIdFrom(call) &&
      (typeof expectedResolutionId !== 'string' || result.resolutionId === expectedResolutionId);
    if (!valid || typeof result.productId !== 'string') return null;
    return {
      productId: result.productId,
      ...(typeof result.resolutionId === 'string' ? { resolutionId: result.resolutionId } : {}),
    };
  } catch {
    return null;
  }
};

const matchingValidatedResolutionFromContext = (
  call: { name: string; args?: Record<string, unknown> },
  results: Array<{ callName: string; status?: string; result?: unknown }> = [],
  expected: { businessId?: string; conversationId?: string; turnId?: string } = {}
): ProductResolution | undefined => {
  const currentProductId = typeof call.args?.productId === 'string' ? call.args.productId : null;
  const currentResolutionId = typeof call.args?.resolutionId === 'string'
    ? call.args.resolutionId
    : undefined;

  const candidate = [...results].reverse().find((result) => {
    if (result.callName !== 'resolve_product' || result.status !== 'EXECUTED') return false;
    const payload = (() => {
      if (result.result == null) return undefined;
      if (typeof result.result === 'string') {
        try {
          const parsed = JSON.parse(result.result) as unknown;
          return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
        } catch {
          return undefined;
        }
      }
      if (typeof result.result === 'object') {
        if ('content' in result.result && typeof (result.result as { content?: unknown }).content === 'string') {
          try {
            const parsed = JSON.parse((result.result as { content: string }).content) as unknown;
            return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
          } catch {
            return undefined;
          }
        }
        return result.result as Record<string, unknown>;
      }
      return undefined;
    })();
    if (
      payload == null ||
      payload.success !== true ||
      typeof payload.productId !== 'string' ||
      typeof payload.resolutionId !== 'string' ||
      typeof payload.businessId !== 'string' ||
      typeof payload.conversationId !== 'string' ||
      payload.status !== 'selected' ||
      !['turn', 'conversation', 'pending'].includes(String(payload.scope)) ||
      typeof payload.createdAt !== 'string' ||
      !(payload.expiresAt === null || typeof payload.expiresAt === 'string')
    ) return false;
    if (currentProductId && payload.productId !== currentProductId) return false;
    if (currentResolutionId && payload.resolutionId !== currentResolutionId) {
      return false;
    }
    if (expected.businessId && payload.businessId !== expected.businessId) return false;
    if (expected.conversationId && payload.conversationId !== expected.conversationId) return false;
    if (payload.expiresAt && (!Number.isFinite(Date.parse(String(payload.expiresAt))) || Date.parse(String(payload.expiresAt)) <= Date.now())) return false;
    if (payload.scope === 'turn' && payload.turnId !== expected.turnId) return false;
    return true;
  });

  if (!candidate) return undefined;
  const payload = (() => {
    if (candidate.result == null) return undefined;
    if (typeof candidate.result === 'string') {
      try {
        const parsed = JSON.parse(candidate.result) as unknown;
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
      } catch {
        return undefined;
      }
    }
    if (typeof candidate.result === 'object') {
      if ('content' in candidate.result && typeof (candidate.result as { content?: unknown }).content === 'string') {
        try {
          const parsed = JSON.parse((candidate.result as { content: string }).content) as unknown;
          return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
        } catch {
          return undefined;
        }
      }
      return candidate.result as Record<string, unknown>;
    }
    return undefined;
  })();
  if (payload == null || typeof payload !== 'object') return undefined;
  return payload as ProductResolution;
};

const deferredProductAdd = (call: ToolCall): ToolMessage =>
  new ToolMessage({
    name: call.name,
    tool_call_id: call.id ?? '',
    status: 'success',
    content: JSON.stringify({
      success: false,
      error: 'product_resolution_required',
      reason: 'resolution_missing',
      message: 'El producto todavía no tiene una resolución vigente.',
      instruction: 'Esperá los resultados de búsqueda y replanteá en el siguiente paso antes de agregarlo.',
    }),
  });

const deferredRequirement = (
  call: ToolCall,
  reason: string,
  missingRequirements: string[] = [],
  askMessage?: string
): ToolMessage => {
  const normalizedReason = reason === 'quantity_required' || reason === 'order_line_quantity_required' || reason === 'variation_required' || reason === 'party_size_required'
    ? reason
    : 'product_resolution_required';

  const labels: Record<string, string> = {
    product_resolution_required: 'El producto todavía no tiene una resolución vigente.',
    quantity_required: 'Falta la cantidad del producto.',
    order_line_quantity_required: 'La línea del pedido todavía no tiene una cantidad confirmada.',
    variation_required: 'Falta la variación del producto.',
    party_size_required: 'Falta la cantidad de personas para el pedido.',
    product_id_required: 'Falta identificar el producto.',
    human_intent_incompatible: 'La operación no corresponde al HumanIntent activo.',
  };

  return new ToolMessage({
    name: call.name,
    tool_call_id: call.id ?? '',
    status: 'success',
    content: JSON.stringify({
      success: false,
      error: normalizedReason,
      reason,
      missingRequirements,
      message: labels[normalizedReason] ?? 'La operación todavía no está autorizada.',
      ...(askMessage ? { askMessage } : {}),
      instruction: normalizedReason === 'order_line_quantity_required'
        ? 'No agregues el producto. Preguntá cuántas unidades quiere y esperá su respuesta; la cantidad se persiste con set_order_line_quantity.'
        : 'Esperá a que se satisfagan los requisitos del flujo antes de ejecutar esta tool.',
    }),
  });
};

export class HumanIntentToolNode extends PostEffectToolNode {
  protected override async run(input: unknown, config: RunnableConfig) {
    const messages: BaseMessage[] = Array.isArray(input)
      ? input as BaseMessage[]
      : typeof input === 'object' && input !== null && 'messages' in input && Array.isArray(input.messages)
        ? input.messages as BaseMessage[]
        : [];
    const aiMessage = [...messages].reverse().find((message) => message.getType() === 'ai');
    const calls = aiMessage instanceof AIMessage ? aiMessage.tool_calls : undefined;
    if (!calls?.length) return super.run(input, config);

    const completedCallIds = new Set(
      messages
        .filter((message): message is ToolMessage => ToolMessage.isInstance(message))
        .map((message) => message.tool_call_id)
    );
    const pendingCalls = calls.filter((call) => call.id == null || !completedCallIds.has(call.id));
    if (pendingCalls.length === 0) return super.run(input, config);

    const hasSearchResolutionChain =
      pendingCalls.some((call) => PRODUCT_SEARCH_TOOLS.has(call.name)) &&
      pendingCalls.some((call) => call.name === 'resolve_product');
    if (hasSearchResolutionChain) {
      const plannerPlan = planToolCalls(pendingCalls, {
        contracts: DEFAULT_TOOL_CONTRACTS,
      });
      const configurable = config.configurable as
        | {
            businessId?: unknown;
            conversationId?: unknown;
            turnId?: unknown;
            orderLineId?: unknown;
            humanIntentGateRevision?: unknown;
            turnStartedAt?: unknown;
          }
        | undefined;

      const businessId = typeof configurable?.businessId === 'string' ? configurable.businessId : undefined;
      const conversationId = typeof configurable?.conversationId === 'string' ? configurable.conversationId : undefined;
      const turnId = typeof configurable?.turnId === 'string' ? configurable.turnId : undefined;
      const configuredOrderLineId = typeof configurable?.orderLineId === 'string' ? configurable.orderLineId.trim() || undefined : undefined;

      const executor = new ToolExecutor({
        runner: async (call, context) => {
          const resolution = matchingValidatedResolutionFromContext(
            call,
            context.results ?? [],
            { businessId, conversationId, turnId }
          );
          return this.runTool(
            call as ToolCall,
            config,
            resolution ? { productId: resolution.productId, resolutionId: resolution.resolutionId } : undefined,
            false,
            resolution
          );
        },
        evaluator: async ({
          toolName,
          callArgs,
          businessId: execBusinessId,
          conversationId: execConversationId,
          turnId: execTurnId,
          validatedProductResolution,
        }) => {
          const state = conversationId && execConversationId === conversationId
            ? await getHumanIntentState(execConversationId).catch(() => null)
            : null;
          const activeIntent = state?.records.find((record) => record.status === 'ACTIVE') ?? null;
          return evaluateToolRequirement({
            toolName,
            callArgs,
            businessId: execBusinessId,
            conversationId: execConversationId,
            turnId: execTurnId,
            humanIntent: activeIntent,
            state,
            validatedProductResolution,
          });
        },
      });

      const executionResults = await executor.execute(plannerPlan, {
        businessId,
        conversationId,
        turnId,
        orderLineId: configuredOrderLineId,
        humanIntent: (await (conversationId ? getHumanIntentState(conversationId).catch(() => null) : null))?.records.find((record) => record.status === 'ACTIVE') ?? null,
        state: conversationId ? await getHumanIntentState(conversationId).catch(() => null) : null,
      });

      const outputs = executionResults.map((result) => {
        if (result.status === 'REJECTED' || result.status === 'DEFERRED' || result.status === 'BLOCKED') {
          if (typeof result.call.id !== 'string' || result.call.id.length === 0) return undefined;
          return new ToolMessage({
            name: result.callName,
            tool_call_id: result.call.id,
            status: 'success',
            content: JSON.stringify({
              success: false,
              error: result.reason ?? 'tool_blocked',
              missingRequirements: result.missingRequirements ?? [],
              message: result.reason ?? 'La operación todavía no está autorizada.',
            }),
          });
        }
        return result.result as ToolMessage | Command | undefined;
      }).filter((output): output is NonNullable<typeof output> => output !== undefined);

      if (!outputs.some(isCommand)) return Array.isArray(input) ? outputs : { messages: outputs };

      const combinedOutputs: unknown[] = [];
      let parentSends: Send[] | null = null;
      for (const output of outputs) {
        if (isCommand(output)) {
          if (
            output.graph === Command.PARENT &&
            Array.isArray(output.goto) &&
            output.goto.every((send) => send instanceof Send)
          ) {
            if (parentSends) parentSends.push(...output.goto);
            else parentSends = [...output.goto];
          } else {
            combinedOutputs.push(output);
          }
        } else {
          combinedOutputs.push(Array.isArray(input) ? [output] : { messages: [output] });
        }
      }
      if (parentSends) combinedOutputs.push(new Command({ graph: Command.PARENT, goto: parentSends }));
      return combinedOutputs;
    }

    const addCalls = pendingCalls.filter((call) => call.name === 'add_cart_item');
    const resolutionCalls = pendingCalls.filter((call) => call.name === 'resolve_product');
    const hasProductSearch = pendingCalls.some((call) => PRODUCT_SEARCH_TOOLS.has(call.name));
    const hasSearchResolutionDependency = hasProductSearch && resolutionCalls.length > 0;
    const hasAddDependency = addCalls.length > 0 && (hasProductSearch || resolutionCalls.length > 0);
    if (!hasSearchResolutionDependency && !hasAddDependency) {
      return super.run(input, config);
    }

    const configurable = config.configurable as
      | {
          businessId?: unknown;
          conversationId?: unknown;
          turnId?: unknown;
          orderLineId?: unknown;
          humanIntentGateRevision?: unknown;
          turnStartedAt?: unknown;
        }
      | undefined;
    const orderMetadata = typeof configurable?.conversationId === 'string'
      ? (await prisma.conversation_state.findUnique({
          where: { conversation_id: configurable.conversationId },
          select: { metadata: true },
        }))?.metadata
      : null;
    const hasOpenTaskQueue = Boolean(
      getPendingOrderLines(orderMetadata)?.lines.some(
        (line) => line.status === 'active' || line.status === 'queued'
      )
    );

    const resolutionByAdd = new Map<ToolCall, ToolCall | undefined>();
    for (const addCall of addCalls) {
      const addArgs = addCall.args as Record<string, unknown>;
      const resolutionCall = resolutionCalls.find((call) => {
        const resolutionArgs = call.args as Record<string, unknown>;
        return (
          resolutionArgs.productId === addArgs.productId &&
          (typeof addArgs.resolutionId !== 'string' || resolutionArgs.resolutionId === addArgs.resolutionId)
        );
      });
      if (resolutionCall) {
        resolutionByAdd.set(addCall, resolutionCall);
      }
    }

    const hasMissingResolutionContext =
      typeof configurable?.businessId !== 'string' ||
      typeof configurable?.conversationId !== 'string';
    const deferredAdds = new Set<ToolCall>();
    const validatedResolutionByAdd = new Map<
      ToolCall,
      { productId: string; resolutionId?: string }
    >();
    await Promise.all(addCalls.map(async (call) => {
      if (resolutionByAdd.has(call)) return;
      const args = call.args as Record<string, unknown>;
      const explicitTaskId = typeof args.orderLineId === 'string'
        ? args.orderLineId.trim()
        : typeof configurable?.orderLineId === 'string'
          ? configurable.orderLineId.trim()
          : '';
      if (hasOpenTaskQueue || explicitTaskId) {
        if (!explicitTaskId || typeof args.resolutionId !== 'string') {
          deferredAdds.add(call);
        }
        return;
      }
      if (hasMissingResolutionContext) {
        deferredAdds.add(call);
        return;
      }
      const productId = productIdFrom(call);
      if (!productId) {
        deferredAdds.add(call);
        return;
      }
      try {
        const resolution = await resolveProductForAdd({
          productId,
          businessId: configurable.businessId as string,
          conversationId: configurable.conversationId as string,
          resolutionId: typeof args.resolutionId === 'string' ? args.resolutionId : undefined,
          turnId: typeof configurable.turnId === 'string' ? configurable.turnId : undefined,
        });
        if (!resolution.ok) {
          deferredAdds.add(call);
        } else {
          validatedResolutionByAdd.set(call, {
            productId: resolution.resolution.productId,
            resolutionId: resolution.resolution.resolutionId,
          });
        }
      } catch {
        deferredAdds.add(call);
      }
    }));

    const independentCalls = pendingCalls.filter(
      (call) => !resolutionCalls.includes(call) && !addCalls.includes(call)
    );
    const independentResults = await Promise.all(
      independentCalls.map((call) => this.runTool(call, config))
    );
    const resolutionResults = await Promise.all(
      resolutionCalls.map((call) => this.runTool(call, config))
    );
    const resolutionMessages = new Map(
      resolutionCalls.map((call, index) => [call, resolutionResults[index]])
    );
    const addResults = await Promise.all(addCalls.map(async (call) => {
      if (deferredAdds.has(call)) return deferredProductAdd(call);
      const resolutionCall = resolutionByAdd.get(call);
      let validatedResolution = validatedResolutionByAdd.get(call);
      if (resolutionCall) {
        const result = resolutionMessages.get(resolutionCall);
        if (!(result instanceof ToolMessage)) {
          return deferredProductAdd(call);
        }
        validatedResolution = validatedProductResolutionFor(result, call) ?? undefined;
        if (!validatedResolution) return deferredProductAdd(call);
      }
      return this.runTool(call, config, validatedResolution);
    }));

    const resultByCall = new Map<ToolCall, unknown>();
    independentCalls.forEach((call, index) => resultByCall.set(call, independentResults[index]));
    resolutionCalls.forEach((call, index) => resultByCall.set(call, resolutionResults[index]));
    addCalls.forEach((call, index) => resultByCall.set(call, addResults[index]));
    const outputs = pendingCalls.map((call) => resultByCall.get(call) ?? deferredProductAdd(call));

    if (!outputs.some(isCommand)) return Array.isArray(input) ? outputs : { messages: outputs };

    const combinedOutputs: unknown[] = [];
    let parentSends: Send[] | null = null;
    for (const output of outputs) {
      if (isCommand(output)) {
        if (
          output.graph === Command.PARENT &&
          Array.isArray(output.goto) &&
          output.goto.every((send) => send instanceof Send)
        ) {
          if (parentSends) parentSends.push(...output.goto);
          else parentSends = [...output.goto];
        } else {
          combinedOutputs.push(output);
        }
      } else {
        combinedOutputs.push(Array.isArray(input) ? [output] : { messages: [output] });
      }
    }
    if (parentSends) combinedOutputs.push(new Command({ graph: Command.PARENT, goto: parentSends }));
    return combinedOutputs;
  }

  protected override async runTool(
    call: ToolCall,
    config: RunnableConfig,
    validatedProductResolution?: { productId: string; resolutionId?: string },
    skipRequirementEvaluation = false,
    validatedResolutionFromExecutionContext?: ProductResolution
  ) {
    const configurable = config.configurable as
      | {
          conversationId?: unknown;
          businessId?: unknown;
          orderLineId?: unknown;
          humanIntentGateRevision?: unknown;
          turnId?: unknown;
          turnStartedAt?: unknown;
        }
      | undefined;
    const conversationId = configurable?.conversationId;
    const businessId = configurable?.businessId;
    const expectedRevision = configurable?.humanIntentGateRevision;
    const turnId = configurable?.turnId;
    const turnStartedAt = configurable?.turnStartedAt;
    const explicitOrderLineId =
      typeof (call.args as Record<string, unknown>)?.orderLineId === 'string'
        ? String((call.args as Record<string, unknown>).orderLineId).trim() || undefined
        : typeof configurable?.orderLineId === 'string'
          ? String(configurable.orderLineId).trim() || undefined
          : undefined;
    const toolConfig =
      (call.name === 'add_cart_item' &&
      validatedResolutionFromExecutionContext?.productId === productIdFrom(call) &&
      validatedResolutionFromExecutionContext.resolutionId ===
        (typeof (call.args as Record<string, unknown>).resolutionId === 'string'
          ? (call.args as Record<string, unknown>).resolutionId
          : validatedResolutionFromExecutionContext.resolutionId)) ||
      (call.name === 'add_cart_item' && explicitOrderLineId) ||
      (call.name === 'resolve_product' && explicitOrderLineId)
        ? {
            ...config,
            configurable: {
              ...config.configurable,
              ...(call.name === 'add_cart_item'
                ? { validatedProductResolutionFromExecutionContext: validatedResolutionFromExecutionContext }
                : {}),
              ...(explicitOrderLineId ? { orderLineId: explicitOrderLineId } : {}),
            },
          }
        : config;

    // Handoffs and legacy direct invocations do not carry a preflight revision.
    if (
      typeof conversationId !== 'string' ||
      typeof businessId !== 'string' ||
      typeof expectedRevision !== 'number'
    ) {
      return super.runTool(call, toolConfig);
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
    if (!active) {
      return super.runTool(call, toolConfig);
    }

    if (call.name === 'add_cart_item') {
      let addProductName: string | null = null;
      try {
        const targets = await toolTargets(call.name, call.args, businessId);
        if (targets?.length) {
          addProductName = targets[0];
          const pendingMatch = pending.find((intent) => matchesIntent(intent, targets));
          if (pendingMatch && !matchesIntent(active, targets)) {
            return internalToolError(call, HUMAN_INTENT_TOOL_DENIED, pendingMatch.id);
          }
        }
      } catch {
        // Requirement evaluation remains authoritative if a display target cannot be loaded.
      }

      if (!skipRequirementEvaluation) {
        let requirementDecision;
        try {
          requirementDecision = await evaluateToolRequirement({
            toolName: call.name,
            callArgs: call.args as Record<string, unknown>,
            businessId,
            conversationId,
            turnId: typeof turnId === 'string' ? turnId : undefined,
            humanIntent: active,
            state,
            validatedProductResolution,
          });
        } catch {
          return internalToolError(call, 'requirement_evaluation_failed');
        }

        if (requirementDecision.type === 'DEFER') {
          if (requirementDecision.reason === 'party_size_required') {
            const args = call.args as Record<string, unknown>;
            const heldOrder = await rememberPartySizeBlockedFood(
              conversationId,
              {
                source: 'lookup',
                summary: summarizeBlockedAdd({
                  name: addProductName ?? '',
                  quantity: typeof args.quantity === 'number' ? args.quantity : null,
                  variation: typeof args.variation === 'string' ? args.variation : null,
                }),
              },
              typeof turnStartedAt === 'string' ? turnStartedAt : undefined
            );
            const payload = {
              ...partySizeRequiredPayload(heldOrder),
              missingRequirements: requirementDecision.missingRequirements,
            };
            return new ToolMessage({
              name: call.name,
              tool_call_id: call.id ?? '',
              status: 'success',
              content: JSON.stringify(payload),
            });
          }
          return deferredRequirement(
            call,
            requirementDecision.reason,
            requirementDecision.missingRequirements,
            requirementDecision.reason === 'order_line_quantity_required'
              ? `¿Cuántas unidades${addProductName ? ` de ${addProductName}` : ''} querés agregar?`
              : undefined
          );
        }
        if (requirementDecision.type === 'REJECT') {
          return internalToolError(call, requirementDecision.reason);
        }
      }
      return super.runTool(call, toolConfig);
    }

    if (pending.length === 0) return super.runTool(call, toolConfig);

    try {
      const targets = await toolTargets(call.name, call.args, businessId);
      if (!targets || targets.length === 0) {
        return super.runTool(call, toolConfig);
      }

      const pendingMatch = pending.find((intent) => matchesIntent(intent, targets));
      if (!pendingMatch || matchesIntent(active, targets)) {
        return super.runTool(call, toolConfig);
      }
      return internalToolError(call, HUMAN_INTENT_TOOL_DENIED, pendingMatch.id);
    } catch {
      // A target that cannot be resolved is not clearly attributable to PENDING.
      return super.runTool(call, toolConfig);
    }
  }
}