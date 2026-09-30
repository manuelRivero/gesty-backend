import {
  DEFAULT_TOOL_CONTRACTS,
  PRODUCT_RESOLUTION,
  requirementMatchesCapability,
  type ToolCallLike,
  type ToolCapability,
  type ToolContract,
  type ToolRequirement,
  type ToolScope,
} from './toolContracts';

export type ToolPlanStatus = 'READY' | 'BLOCKED' | 'DEFERRED';

export type ToolPlanStep = {
  calls: ToolCallLike[];
  status: ToolPlanStatus;
  reason?: string;
};

export type ToolPlan = {
  steps: ToolPlanStep[];
  status: ToolPlanStatus;
};

export type PlannerState = {
  productResolutions?: Array<{
    productId?: string;
    status?: string;
    expiresAt?: string | null;
  }>;
};

export type PlannerToolResult = {
  toolName?: string;
  producedCapabilities?: ToolCapability[];
  capabilities?: ToolCapability[];
};

export type ToolPlannerOptions = {
  contracts?: ToolContract[];
  currentState?: PlannerState;
  previousToolResults?: PlannerToolResult[];
};

const withProductScope = (scope: ToolScope | undefined, call: ToolCallLike): ToolScope | undefined => {
  const args = (call.args ?? {}) as Record<string, unknown>;
  const productId = typeof args.productId === 'string' ? args.productId : undefined;
  if (!productId) return scope;
  return { ...(scope ?? {}), productId };
};

const toCapability = (call: ToolCallLike, capability: ToolCapability): ToolCapability => ({
  ...capability,
  scope: withProductScope(capability.scope, call),
});

const resolveContract = (
  name: string,
  contracts: ToolContract[] = DEFAULT_TOOL_CONTRACTS
): ToolContract | undefined => contracts.find((contract) => contract.name === name);

const stateCapabilities = (currentState?: PlannerState): ToolCapability[] => {
  const capabilities: ToolCapability[] = [];
  for (const resolution of currentState?.productResolutions ?? []) {
    const productId = typeof resolution.productId === 'string' ? resolution.productId : undefined;
    if (!productId) continue;
    if (resolution.status === 'consumed') continue;
    if (resolution.expiresAt && Date.parse(resolution.expiresAt) <= Date.now()) continue;
    capabilities.push({
      type: PRODUCT_RESOLUTION,
      scope: { productId },
    });
  }
  return capabilities;
};

const previousCapabilities = (previousToolResults?: PlannerToolResult[]): ToolCapability[] =>
  (previousToolResults ?? [])
    .flatMap((result) => result.producedCapabilities ?? result.capabilities ?? []);

const findMatchingProducer = (
  call: ToolCallLike,
  pending: ToolCallLike[],
  contracts: ToolContract[] = DEFAULT_TOOL_CONTRACTS,
  available: ToolCapability[]
): ToolCallLike | undefined => {
  const contract = resolveContract(call.name, contracts);
  if (!contract?.requires?.length) return undefined;

  for (const requirement of contract.requires) {
    const scopedRequirement: ToolRequirement = {
      ...requirement,
      scope: withProductScope(requirement.scope, call),
    };
    const satisfied = available.some((capability) => requirementMatchesCapability(scopedRequirement, capability));
    if (satisfied) continue;

    const producer = pending.find((candidate) => {
      if (candidate.name === call.name) return false;
      const candidateContract = resolveContract(candidate.name, contracts);
      if (!candidateContract?.produces?.length) return false;
      return candidateContract.produces.some((capability) =>
        requirementMatchesCapability(scopedRequirement, toCapability(candidate, capability))
      );
    });
    if (producer) return producer;
  }

  return undefined;
};

export class ToolPlanner {
  public plan(toolCalls: ToolCallLike[], options: ToolPlannerOptions = {}): ToolPlan {
    const contracts = options.contracts ?? DEFAULT_TOOL_CONTRACTS;
    const available: ToolCapability[] = [
      ...stateCapabilities(options.currentState),
      ...previousCapabilities(options.previousToolResults),
    ];
    let pending = [...toolCalls];
    const steps: ToolPlanStep[] = [];
    let overallStatus: ToolPlanStatus = 'READY';

    while (pending.length > 0) {
      const ready: ToolCallLike[] = [];
      const producerSteps: ToolCallLike[] = [];
      const blocked: ToolCallLike[] = [];

      for (const call of pending) {
        const contract = resolveContract(call.name, contracts);
        const missingRequirements = (contract?.requires ?? []).filter((requirement) => {
          const scopedRequirement: ToolRequirement = {
            ...requirement,
            scope: withProductScope(requirement.scope, call),
          };
          return !available.some((capability) =>
            requirementMatchesCapability(scopedRequirement, capability)
          );
        });

        if (missingRequirements.length === 0) {
          ready.push(call);
          continue;
        }

        const canProduceForAnother = pending.some((candidate) => {
          if (candidate.id === call.id) return false;
          const candidateContract = resolveContract(candidate.name, contracts);
          if (!candidateContract?.requires?.length) return false;
          return candidateContract.requires.some((requirement) => {
            const scopedRequirement: ToolRequirement = {
              ...requirement,
              scope: withProductScope(requirement.scope, candidate),
            };
            return (contract?.produces ?? []).some((capability) =>
              requirementMatchesCapability(scopedRequirement, toCapability(call, capability))
            );
          });
        });

        if (canProduceForAnother) {
          producerSteps.push(call);
          continue;
        }

        blocked.push(call);
      }

      if (ready.length === 0 && producerSteps.length === 0) {
        if (blocked.length > 0) {
          steps.push({
            calls: blocked,
            status: 'BLOCKED',
            reason: 'missing_producer_or_requirement',
          });
          overallStatus = 'BLOCKED';
        }
        break;
      }

      const scheduled = ready.length > 0 ? ready : producerSteps;
      steps.push({
        calls: scheduled,
        status: ready.length > 0 ? 'READY' : 'DEFERRED',
        reason: ready.length > 0 ? undefined : 'dependency_waiting_for_producer',
      });
      if (ready.length > 0) overallStatus = 'READY';
      if (ready.length === 0 && producerSteps.length > 0) overallStatus = 'DEFERRED';

      for (const call of scheduled) {
        const contract = resolveContract(call.name, contracts);
        for (const capability of contract?.produces ?? []) {
          available.push(toCapability(call, capability));
        }
      }

      pending = pending.filter((call) => !scheduled.some((scheduledCall) => scheduledCall.id === call.id));
    }

    return { steps, status: overallStatus === 'READY' ? 'READY' : overallStatus };
  }
}

export const planToolCalls = (
  toolCalls: ToolCallLike[],
  options: ToolPlannerOptions = {}
): ToolPlan => new ToolPlanner().plan(toolCalls, options);

export const createToolPlan = planToolCalls;
export default ToolPlanner;
