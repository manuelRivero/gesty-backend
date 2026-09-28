import { ToolMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import type { RunnableConfig } from '@langchain/core/runnables';
import { ToolNode } from '@langchain/langgraph/prebuilt';
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