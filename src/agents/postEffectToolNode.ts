import { ToolMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import type { RunnableConfig } from '@langchain/core/runnables';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { prisma } from '../lib/prisma';
import { deriveOrderQuantityGoalCandidate, deriveOrderQuantityGoalTarget } from '../services/orderQuantityGoal.service';
import { getRequestedPartySize, normalizeMetadata } from '../services/productQuery/utils';
import { hasActivePedirHumanIntent } from '../services/partySizeGoal.service';
import { getGoalFulfillmentContractsForTool } from '../domain/intent/family';
import { reconcileHumanIntentAfterToolEffect } from '../services/humanIntentReconciliation.service';

export class PostEffectToolNode extends ToolNode {
  protected override async runTool(call: ToolCall, config: RunnableConfig) {
    const result = await super.runTool(call, config);
    if (!(result instanceof ToolMessage) || result.status !== 'success') return result;

    const configurable = config.configurable as
      | {
          conversationId?: unknown;
          businessId?: unknown;
          customerPhone?: unknown;
          turnId?: unknown;
        }
      | undefined;
    const conversationId = configurable?.conversationId;
    const businessId = configurable?.businessId;
    const customerPhone = configurable?.customerPhone;
    if (
      typeof conversationId !== 'string' ||
      typeof businessId !== 'string' ||
      typeof customerPhone !== 'string'
    ) {
      return result;
    }

    try {
      const effectData =
        typeof result.content === 'string'
          ? (JSON.parse(result.content) as Record<string, unknown>)
          : {};
      const descriptor = effectData.effect;
      if (typeof descriptor !== 'object' || descriptor === null) return result;
      const reference =
        typeof (descriptor as { reference?: unknown }).reference === 'string'
          ? (descriptor as { reference: string }).reference
          : undefined;
      const kind =
        typeof (descriptor as { kind?: unknown }).kind === 'string'
          ? (descriptor as { kind: string }).kind
          : call.name;

      for (const { goalType, contract } of getGoalFulfillmentContractsForTool(call.name)) {
        console.log(JSON.stringify({
          event: '[goal-fulfillment]',
          goal: goalType,
          tool: call.name,
          expectedEffect: contract.expectedEffect,
          actualEffect: kind,
          result: contract.expectedEffect === kind ? 'effect_verified' : 'effect_mismatch',
        }));
      }

      await reconcileHumanIntentAfterToolEffect({
        conversationId,
        businessId,
        customerPhone,
        effect: {
          kind,
          ...(reference ? { reference } : {}),
          occurredAt: new Date().toISOString(),
          success: true,
        },
      });
      if (kind === 'party_size_persisted' || kind === 'order_line_quantity_persisted') {
        const fresh = await prismaConversationMetadata(conversationId);
        const metadata = normalizeMetadata(fresh);
        const target = deriveOrderQuantityGoalTarget({
          activePedir: hasActivePedirHumanIntent(metadata),
          checkoutActive: metadata.checkout_active === true,
          partySizeKnown: getRequestedPartySize(metadata) != null,
          metadata,
        });
        if (target) {
          const candidate = deriveOrderQuantityGoalCandidate(
            {
              activePedir: true,
              checkoutActive: metadata.checkout_active === true,
              partySizeKnown: true,
              metadata,
            },
            metadata.intentLedger?.OBTENER_CANTIDAD_DEL_PRODUCTO
          );
          effectData.nextGoal = {
            type: candidate?.type ?? 'OBTENER_CANTIDAD_DEL_PRODUCTO',
            target: { orderLineId: target.id, hint: target.hint },
            instruction:
              `Falta la cantidad de "${target.hint}". Preguntá cuántas unidades quiere; ` +
              'no busques ni agregues ese producto hasta recibir una cantidad confirmada.',
          };
          return new ToolMessage({
            name: result.name,
            tool_call_id: result.tool_call_id,
            status: result.status,
            content: JSON.stringify(effectData),
          });
        }
      }
    console.log(JSON.stringify({
      event: '[reconcile]',
      turnId: typeof configurable?.turnId === 'string' ? configurable.turnId : undefined,
      effect: kind,
      success: true,
    }));
    } catch (error) {
      console.error('[human-intent] post-tool reconciliation failed:', error);
    }
    return result;
  }
}

const prismaConversationMetadata = async (conversationId: string): Promise<unknown> => {
  const row = await prisma.conversation_state.findUnique({
    where: { conversation_id: conversationId },
    select: { metadata: true },
  });
  return row?.metadata ?? {};
};