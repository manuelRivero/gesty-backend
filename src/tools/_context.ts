import type { RunnableConfig } from '@langchain/core/runnables';

export interface ReactAgentContext {
  businessId: string;
  customerId: string;
  customerPhone: string;
  conversationId: string;
  conversationStartedAt: string;
}

export const getReactContext = (config?: RunnableConfig): ReactAgentContext => {
  const ctx = (config?.configurable ?? {}) as Partial<ReactAgentContext>;
  if (!ctx.businessId) throw new Error('[tool] missing businessId in config');
  if (!ctx.customerId) throw new Error('[tool] missing customerId in config');
  if (!ctx.customerPhone) throw new Error('[tool] missing customerPhone in config');
  if (!ctx.conversationId) throw new Error('[tool] missing conversationId in config');
  if (!ctx.conversationStartedAt) throw new Error('[tool] missing conversationStartedAt in config');
  return ctx as ReactAgentContext;
};
