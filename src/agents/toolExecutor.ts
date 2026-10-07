import type { ToolCallLike } from './toolContracts';
import { DEFAULT_TOOL_CONTRACTS } from './toolContracts';
import type { ToolPlan, ToolPlanStatus } from './toolPlanner';
import type { HumanIntentRecord, HumanIntentStateV1 } from '../services/humanIntentState.service';
import { evaluateToolRequirement } from '../services/requirementEvaluator';

export type ToolExecutionDecision =
  | { type: 'ALLOW' }
  | { type: 'DEFER'; reason: string; missingRequirements?: string[] }
  | { type: 'REJECT'; reason: string; missingRequirements?: string[] };

export type ToolExecutionContext = {
  businessId?: string;
  conversationId?: string;
  turnId?: string;
  traceId?: string;
  orderLineId?: string | null;
  humanIntent?: HumanIntentRecord | null;
  state?: HumanIntentStateV1 | null;
  results?: ExecutorResult[];
};

export type ExecutorResult = {
  callName: string;
  call: ToolCallLike;
  status: ToolPlanStatus | 'EXECUTED' | 'DEFERRED' | 'REJECTED' | 'SKIPPED';
  reason?: string;
  missingRequirements?: string[];
  result?: unknown;
};

export type ToolExecutorOptions = {
  runner?: (call: ToolCallLike, context: ToolExecutionContext) => Promise<unknown>;
  evaluator?: (
    params: {
      toolName: string;
      callArgs: Record<string, unknown>;
      businessId: string;
      conversationId: string;
      turnId?: string;
      humanIntent?: HumanIntentRecord | null;
      state?: HumanIntentStateV1 | null;
      context: ToolExecutionContext;
      validatedProductResolution?: { productId: string; resolutionId?: string };
    }
  ) => Promise<ToolExecutionDecision>;
  contracts?: typeof DEFAULT_TOOL_CONTRACTS;
};

const payloadFromToolResult = (value: unknown): Record<string, unknown> | undefined => {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  if (typeof value === 'object') {
    if ('content' in value && typeof (value as { content?: unknown }).content === 'string') {
      try {
        const parsed = JSON.parse((value as { content: string }).content) as unknown;
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
      } catch {
        return undefined;
      }
    }
    return value as Record<string, unknown>;
  }
  return undefined;
};

const matchingValidatedResolution = (
  call: ToolCallLike,
  results: ExecutorResult[] = [],
  context: ToolExecutionContext = {}
): { productId: string; resolutionId?: string } | undefined => {
  const callProductId = typeof call.args?.productId === 'string' ? call.args.productId : undefined;
  const callResolutionId = typeof call.args?.resolutionId === 'string' ? call.args.resolutionId : undefined;

  const candidate = [...results].reverse().find((result) => {
    if (result.callName !== 'resolve_product' || result.status !== 'EXECUTED') return false;
    const payload = payloadFromToolResult(result.result);
    if (
      payload == null ||
      payload.success !== true ||
      typeof payload.productId !== 'string' ||
      typeof payload.resolutionId !== 'string'
    ) return false;
    if (callProductId && payload.productId !== callProductId) return false;
    if (callResolutionId && payload.resolutionId !== callResolutionId) return false;
    if (context.businessId && payload.businessId !== context.businessId) return false;
    if (context.conversationId && payload.conversationId !== context.conversationId) return false;
    if (context.businessId && payload.status !== 'selected') return false;
    if (context.businessId && !['turn', 'conversation', 'pending'].includes(String(payload.scope))) return false;
    if (
      typeof payload.expiresAt === 'string' &&
      (!Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= Date.now())
    ) return false;
    if (payload.scope === 'turn' && payload.turnId !== context.turnId) return false;
    return typeof payload.productId === 'string';
  });

  const payload = candidate ? payloadFromToolResult(candidate.result) : undefined;
  if (payload == null || typeof payload.productId !== 'string') return undefined;
  return {
    productId: payload.productId,
    ...(typeof payload.resolutionId === 'string' ? { resolutionId: payload.resolutionId } : {}),
  };
};

export class ToolExecutor {
  constructor(private readonly options: ToolExecutorOptions = {}) {}

  public async execute(
    plan: ToolPlan,
    context: ToolExecutionContext = {}
  ): Promise<ExecutorResult[]> {
    const results: ExecutorResult[] = [];
    const runner = this.options.runner ?? (async (call) => ({ ok: true, callName: call.name }));

    for (const step of plan.steps) {
      const stepContext: ToolExecutionContext = { ...context, results: [...results] };
      const stepResults = await Promise.all(step.calls.map(async (call): Promise<ExecutorResult> => {
        if (step.status === 'BLOCKED') {
          return {
            callName: call.name,
            call,
            status: 'BLOCKED',
            reason: step.reason ?? 'missing_producer_or_requirement',
          };
        }

        if (step.status === 'DEFERRED') {
          return {
            callName: call.name,
            call,
            status: 'DEFERRED',
            reason: step.reason ?? 'dependency_waiting_for_producer',
          };
        }

        const wantFinalValidation = this.options.evaluator
          ?? (context.businessId && context.conversationId ? evaluateToolRequirement : undefined);

        if (wantFinalValidation) {
          const validatedProductResolution = matchingValidatedResolution(
            call,
            stepContext.results ?? [],
            context
          );
          const decision = await wantFinalValidation({
            toolName: call.name,
            callArgs: (call.args ?? {}) as Record<string, unknown>,
            businessId: context.businessId ?? '',
            conversationId: context.conversationId ?? '',
            turnId: context.turnId,
            orderLineId: context.orderLineId,
            humanIntent: context.humanIntent,
            state: context.state,
            context: stepContext,
            validatedProductResolution,
          });

          if (decision.type === 'DEFER') {
            return {
              callName: call.name,
              call,
              status: 'DEFERRED',
              reason: decision.reason,
              missingRequirements: decision.missingRequirements,
            };
          }

          if (decision.type === 'REJECT') {
            return {
              callName: call.name,
              call,
              status: 'REJECTED',
              reason: decision.reason,
              missingRequirements: decision.missingRequirements,
            };
          }
        }

        const args = (call.args ?? {}) as Record<string, unknown>;
        console.log(JSON.stringify({
          event: '[TRACE-ORDERLINE]',
          stage: 'ToolExecutor.before_invoke',
          traceId: context.traceId ?? (context.conversationId ? `${context.conversationId}:${context.turnId ?? 'no-turn'}` : null),
          conversationId: context.conversationId ?? null,
          turnId: context.turnId ?? null,
          toolCallId: typeof call.id === 'string' ? call.id : null,
          toolName: call.name,
          input: call.args ?? {},
          orderLineId: typeof args.orderLineId === 'string' ? args.orderLineId : null,
          productId: typeof args.productId === 'string' ? args.productId : null,
          resolutionId: typeof args.resolutionId === 'string' ? args.resolutionId : null,
          quantity: typeof args.quantity === 'number' ? args.quantity : null,
        }));

        const value = await runner(call, stepContext);
        return { callName: call.name, call, status: 'EXECUTED', result: value };
      }));
      results.push(...stepResults);
    }

    return results;
  }
}

export const executeToolPlan = (
  plan: ToolPlan,
  context: ToolExecutionContext = {},
  options: ToolExecutorOptions = {}
): Promise<ExecutorResult[]> => new ToolExecutor(options).execute(plan, context);

export default ToolExecutor;
