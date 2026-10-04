import { z } from 'zod';
import type { HumanIntentRecord, HumanIntentStateV1 } from './humanIntentState.service';
import { prisma } from '../lib/prisma';
import { resolveProductForAdd } from './productResolution.service';
import { getPendingAddQuantity } from './pendingAddQuantity.service';
import { getPendingVariation } from './pendingVariation.service';
import { normalizeMetadata } from './productQuery/utils';
import { isPartySizeMissingForOrderingTools } from './partySizeGoal.service';
import {
  getCurrentProductResolutionForTask,
  getPendingOrderLines,
  validateTaskResolutionOwnership,
} from './pendingOrderLines.service';

export type RequirementDecision =
  | { type: 'ALLOW' }
  | { type: 'DEFER'; reason: string; missingRequirements: string[] }
  | { type: 'REJECT'; reason: string; missingRequirements?: string[] };

export type RequirementEvaluationParams = {
  toolName: string;
  callArgs: Record<string, unknown>;
  businessId: string;
  conversationId: string;
  turnId?: string;
  orderLineId?: string | null;
  humanIntent?: HumanIntentRecord | null;
  state?: HumanIntentStateV1 | null;
  validatedProductResolution?: { productId: string; resolutionId?: string };
};

const readConversationMetadata = async (conversationId: string): Promise<unknown> => {
  const row = await prisma.conversation_state.findUnique({
    where: { conversation_id: conversationId },
    select: { metadata: true },
  });
  return row?.metadata ?? {};
};

const pendingResolutionId = (metadata: unknown, productId: string): string | undefined => {
  const pendingQuantity = getPendingAddQuantity(metadata);
  if (pendingQuantity?.productId === productId && pendingQuantity.productResolutionId) {
    return pendingQuantity.productResolutionId;
  }

  const pendingVariation = getPendingVariation(metadata);
  if (pendingVariation?.productId === productId && pendingVariation.productResolutionId) {
    return pendingVariation.productResolutionId;
  }

  return undefined;
};

export const evaluateToolRequirement = async (
  params: RequirementEvaluationParams
): Promise<RequirementDecision> => {
  if (params.toolName !== 'add_cart_item') return { type: 'ALLOW' };

  const activeIntent =
    params.state?.records.find((record) => record.status === 'ACTIVE') ??
    params.humanIntent ??
    null;
  if (!activeIntent) return { type: 'ALLOW' };

  if (activeIntent.goal !== 'PEDIR') {
    return {
      type: 'REJECT',
      reason: 'human_intent_incompatible',
      missingRequirements: ['HUMAN_INTENT_PEDIR'],
    };
  }

  const productId = params.callArgs.productId;
  if (typeof productId !== 'string' || !z.string().uuid().safeParse(productId).success) {
    return { type: 'ALLOW' };
  }

  const metadata = await readConversationMetadata(params.conversationId);
  const pendingLines = getPendingOrderLines(metadata);
  const taskId = typeof params.callArgs.orderLineId === 'string'
    ? params.callArgs.orderLineId.trim()
    : params.orderLineId?.trim() ?? '';
  const taskBound = Boolean(taskId) || Boolean(
    pendingLines?.lines.some((line) => line.status === 'active' || line.status === 'queued')
  );
  let validatedResolution: { ok: true } | { ok: false; reason: string };
  if (taskBound) {
    const resolutionId = typeof params.callArgs.resolutionId === 'string'
      ? params.callArgs.resolutionId.trim()
      : '';
    if (!taskId || !resolutionId) {
      return {
        type: 'DEFER',
        reason: !taskId ? 'order_line_id_required' : 'resolution_id_required',
        missingRequirements: ['TASK_RESOLUTION_PAIR'],
      };
    }
    const ownership = validateTaskResolutionOwnership({ metadata, taskId, resolutionId });
    if (!ownership.ok) {
      return {
        type: 'DEFER',
        reason: ownership.reason,
        missingRequirements: ['TASK_RESOLUTION_PAIR'],
      };
    }
    const taskResolution = getCurrentProductResolutionForTask({
      task: ownership.task,
      metadata,
      businessId: params.businessId,
      conversationId: params.conversationId,
    });
    validatedResolution = taskResolution.ok && taskResolution.resolution.productId === productId
      ? { ok: true }
      : { ok: false, reason: taskResolution.ok ? 'resolution_product_mismatch' : taskResolution.reason };
  } else {
    validatedResolution = params.validatedProductResolution?.productId === productId
      ? { ok: true }
      : await resolveProductForAdd({
          productId,
          businessId: params.businessId,
          conversationId: params.conversationId,
          resolutionId:
            typeof params.callArgs.resolutionId === 'string'
              ? params.callArgs.resolutionId
              : undefined,
          turnId: params.turnId,
          pendingResolutionId: pendingResolutionId(metadata, productId),
        });
  }

  if (!validatedResolution.ok) {
    return {
      type: 'DEFER',
      reason: validatedResolution.reason,
      missingRequirements: ['PRODUCT_RESOLVED'],
    };
  }

  if (isPartySizeMissingForOrderingTools(normalizeMetadata(metadata))) {
    return {
      type: 'DEFER',
      reason: 'party_size_required',
      missingRequirements: ['PARTY_SIZE_OBTAINED'],
    };
  }

  return { type: 'ALLOW' };
};
