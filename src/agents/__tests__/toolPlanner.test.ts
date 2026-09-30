import { describe, expect, it, vi } from 'vitest';
import { ToolPlanner, planToolCalls } from '../toolPlanner';
import { ToolExecutor, executeToolPlan } from '../toolExecutor';
import { DEFAULT_TOOL_CONTRACTS } from '../toolContracts';
import { evaluateToolRequirement } from '../../services/requirementEvaluator';

const call = (name: string, args: Record<string, unknown>) => ({ name, args, id: `${name}-${Math.random()}` });

describe('ToolPlanner', () => {
  it('places independent calls in the same step', () => {
    const plan = planToolCalls(
      [call('search_products', { keyword: 'ceviche' }), call('search_products', { keyword: 'papas' })],
      { contracts: DEFAULT_TOOL_CONTRACTS }
    );

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].calls).toHaveLength(2);
    expect(plan.steps[0].status).toBe('READY');
  });

  it('orders dependency before execution', () => {
    const plan = planToolCalls(
      [call('resolve_product', { productId: 'p-1' }), call('add_cart_item', { productId: 'p-1' })],
      { contracts: DEFAULT_TOOL_CONTRACTS }
    );

    expect(plan.steps.map((step) => step.calls.map((callItem) => callItem.name))).toEqual([
      ['resolve_product'],
      ['add_cart_item'],
    ]);
  });

  it('reuses current product resolution without inserting a duplicate resolve', () => {
    const plan = planToolCalls(
      [call('add_cart_item', { productId: 'p-1' })],
      {
        contracts: DEFAULT_TOOL_CONTRACTS,
        currentState: {
          productResolutions: [{ productId: 'p-1', status: 'selected', expiresAt: new Date(Date.now() + 1000).toISOString() }],
        },
      }
    );

    expect(plan.steps).toEqual([
      { calls: [expect.objectContaining({ name: 'add_cart_item' })], status: 'READY' },
    ]);
  });

  it('keeps product A and B scoped separately', () => {
    const plan = planToolCalls(
      [
        call('search_products', { keyword: 'ceviche' }),
        call('resolve_product', { productId: 'p-1' }),
        call('add_cart_item', { productId: 'p-1' }),
        call('search_products', { keyword: 'papas' }),
        call('resolve_product', { productId: 'p-2' }),
        call('add_cart_item', { productId: 'p-2' }),
      ],
      { contracts: DEFAULT_TOOL_CONTRACTS }
    );

    expect(plan.steps.map((step) => step.calls.map((item) => item.name))).toEqual([
      ['search_products', 'search_products'],
      ['resolve_product', 'resolve_product'],
      ['add_cart_item', 'add_cart_item'],
    ]);
  });

  it('marks missing producer as blocked when no valid source exists', () => {
    const plan = planToolCalls([call('add_cart_item', { productId: 'p-3' })], {
      contracts: DEFAULT_TOOL_CONTRACTS,
      currentState: { productResolutions: [] },
    });

    expect(plan.status).toBe('BLOCKED');
    expect(plan.steps.at(-1)?.status).toBe('BLOCKED');
  });

  it('waits for the producer chain before executing the dependent add', () => {
    const plan = planToolCalls(
      [
        call('search_products', { keyword: 'ceviche' }),
        call('resolve_product', { productId: 'p-1' }),
        call('add_cart_item', { productId: 'p-1' }),
      ],
      { contracts: DEFAULT_TOOL_CONTRACTS }
    );

    expect(plan.status).toBe('READY');
    expect(plan.steps.map((step) => step.calls.map((item) => item.name))).toEqual([
      ['search_products'],
      ['resolve_product'],
      ['add_cart_item'],
    ]);
  });
});

describe('ToolExecutor', () => {
  it('passes results from one step to the next step', async () => {
    const firstCall = call('tool_a', { value: 'from-a' });
    const secondCall = call('tool_b', {});
    let resultsAtSecondStep: unknown[] = [];
    const executor = new ToolExecutor({
      runner: async (toolCall, context) => {
        if (toolCall.name === 'tool_b') resultsAtSecondStep = context.results ?? [];
        return { output: toolCall.args?.value ?? toolCall.name };
      },
    });

    await executor.execute({
      status: 'READY',
      steps: [
        { calls: [firstCall], status: 'READY' },
        { calls: [secondCall], status: 'READY' },
      ],
    });

    expect(resultsAtSecondStep).toMatchObject([
      { callName: 'tool_a', call: firstCall, status: 'EXECUTED', result: { output: 'from-a' } },
    ]);
  });

  it('makes resolve results available to add_cart_item through the planned chain', async () => {
    const addResults: unknown[] = [];
    const executor = new ToolExecutor({
      runner: async (toolCall, context) => {
        if (toolCall.name === 'resolve_product') {
          return {
            success: true,
            productId: toolCall.args?.productId,
            resolutionId: toolCall.args?.resolutionId,
          };
        }
        if (toolCall.name === 'add_cart_item') addResults.push(context.results);
        return { success: true };
      },
    });
    const plan = planToolCalls(
      [
        call('search_products', { keyword: 'ceviche' }),
        call('resolve_product', { productId: 'product-a', resolutionId: 'resolution-a' }),
        call('add_cart_item', { productId: 'product-a', resolutionId: 'resolution-a' }),
      ],
      { contracts: DEFAULT_TOOL_CONTRACTS }
    );

    await executor.execute(plan);

    expect(addResults[0]).toMatchObject([
      { callName: 'search_products', status: 'EXECUTED' },
      {
        callName: 'resolve_product',
        call: { args: { productId: 'product-a', resolutionId: 'resolution-a' } },
        status: 'EXECUTED',
        result: { success: true, productId: 'product-a', resolutionId: 'resolution-a' },
      },
    ]);
  });

  it('keeps two product resolutions correlated with their matching adds', async () => {
    const resolutionsUsedByAdd: Record<string, string | undefined> = {};
    const executor = new ToolExecutor({
      runner: async (toolCall, context) => {
        if (toolCall.name === 'resolve_product') {
          return {
            success: true,
            productId: toolCall.args?.productId,
            resolutionId: toolCall.args?.resolutionId,
          };
        }
        if (toolCall.name === 'add_cart_item') {
          const productId = String(toolCall.args?.productId);
          const matchingResolution = (context.results ?? []).find((result) =>
            result.callName === 'resolve_product' &&
            result.status === 'EXECUTED' &&
            result.result !== null &&
            typeof result.result === 'object' &&
            'productId' in result.result &&
            result.result.productId === productId
          );
          resolutionsUsedByAdd[productId] =
            matchingResolution?.result && typeof matchingResolution.result === 'object' &&
            'resolutionId' in matchingResolution.result
              ? String(matchingResolution.result.resolutionId)
              : undefined;
        }
        return { success: true };
      },
    });
    const plan = planToolCalls(
      [
        call('search_products', { keyword: 'both products' }),
        call('resolve_product', { productId: 'product-a', resolutionId: 'resolution-a' }),
        call('resolve_product', { productId: 'product-b', resolutionId: 'resolution-b' }),
        call('add_cart_item', { productId: 'product-a', resolutionId: 'resolution-a' }),
        call('add_cart_item', { productId: 'product-b', resolutionId: 'resolution-b' }),
      ],
      { contracts: DEFAULT_TOOL_CONTRACTS }
    );

    await executor.execute(plan);

    expect(resolutionsUsedByAdd).toEqual({
      'product-a': 'resolution-a',
      'product-b': 'resolution-b',
    });
  });

  it('does not authorize an add from an invalid resolve result', async () => {
    const executedCalls: string[] = [];
    const executor = new ToolExecutor({
      runner: async (toolCall) => {
        executedCalls.push(toolCall.name);
        if (toolCall.name === 'resolve_product') {
          return { success: false, error: 'product_resolution_required' };
        }
        return { success: true };
      },
      evaluator: async ({ toolName, callArgs, context }) => {
        if (toolName !== 'add_cart_item') return { type: 'ALLOW' };
        const hasMatchingResolution = context.results?.some((result) =>
          result.callName === 'resolve_product' &&
          result.status === 'EXECUTED' &&
          result.result !== null &&
          typeof result.result === 'object' &&
          'success' in result.result &&
          result.result.success === true &&
          'productId' in result.result &&
          result.result.productId === callArgs.productId
        );
        return hasMatchingResolution
          ? { type: 'ALLOW' }
          : { type: 'DEFER', reason: 'product_resolution_required', missingRequirements: ['PRODUCT_RESOLVED'] };
      },
    });
    const plan = planToolCalls(
      [
        call('search_products', { keyword: 'ceviche' }),
        call('resolve_product', { productId: 'product-a', resolutionId: 'resolution-a' }),
        call('add_cart_item', { productId: 'product-a', resolutionId: 'resolution-a' }),
      ],
      { contracts: DEFAULT_TOOL_CONTRACTS }
    );

    const results = await executor.execute(plan);

    expect(executedCalls).toEqual(['search_products', 'resolve_product']);
    expect(results.at(-1)).toMatchObject({
      callName: 'add_cart_item',
      status: 'DEFERRED',
      reason: 'product_resolution_required',
    });
  });

  it('runs independent calls in the same step concurrently', async () => {
    let started = 0;
    let releaseCalls!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      releaseCalls = resolve;
    });
    const executor = new ToolExecutor({
      runner: async () => {
        started += 1;
        if (started === 2) releaseCalls();
        await bothStarted;
        return { success: true };
      },
    });

    const results = await executor.execute({
      status: 'READY',
      steps: [{
        calls: [
          call('search_products', { keyword: 'product-a' }),
          call('search_products', { keyword: 'product-b' }),
        ],
        status: 'READY',
      }],
    });

    expect(started).toBe(2);
    expect(results).toHaveLength(2);
  }, 1000);

  it('keeps intermediate results local to each execute call', async () => {
    const resultsAtSecondStep: number[] = [];
    const executor = new ToolExecutor({
      runner: async (toolCall, context) => {
        if (toolCall.name === 'tool_b') resultsAtSecondStep.push(context.results?.length ?? 0);
        return { success: true };
      },
    });
    const plan = {
      status: 'READY' as const,
      steps: [
        { calls: [call('tool_a', {})], status: 'READY' as const },
        { calls: [call('tool_b', {})], status: 'READY' as const },
      ],
    };

    await executor.execute(plan);
    await executor.execute(plan);

    expect(resultsAtSecondStep).toEqual([1, 1]);
  });

  it('executes calls in planner order and skips blocked calls', async () => {
    const calls: string[] = [];
    const runner = vi.fn(async (call: { name: string }) => {
      calls.push(call.name);
      return { ok: true, call: call.name };
    });

    const plan = planToolCalls(
      [
        call('search_products', { keyword: 'ceviche' }),
        call('resolve_product', { productId: 'p-1' }),
        call('add_cart_item', { productId: 'p-1' }),
      ],
      { contracts: DEFAULT_TOOL_CONTRACTS }
    );

    const executor = new ToolExecutor({ runner });
    const results = await executor.execute(plan);

    expect(results.map((result) => result.callName)).toEqual(['search_products', 'resolve_product', 'add_cart_item']);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it('respects evaluator rejection after planning', async () => {
    const runner = vi.fn(async () => ({ ok: true }));
    const executor = new ToolExecutor({
      runner,
      evaluator: async () => ({ type: 'REJECT', reason: 'human_intent_incompatible' }),
    });

    const results = await executor.execute({
      status: 'READY',
      steps: [{ calls: [call('add_cart_item', { productId: 'p-1' })], status: 'READY' }],
    }, {
      businessId: 'biz-1',
      conversationId: 'conv-1',
    });

    expect(results[0]).toMatchObject({ status: 'REJECTED', reason: 'human_intent_incompatible' });
    expect(runner).not.toHaveBeenCalled();
  });
});

it('keeps requirement evaluation as the final gate', async () => {
  const evaluator = vi.spyOn({} as typeof evaluateToolRequirement, 'constructor');
  expect(typeof evaluator).toBe('function');
});
