import type { RunnableConfig } from '@langchain/core/runnables';
import type { ProductResolution } from '../services/productResolution.service';

export interface ReactAgentContext {
  businessId: string;
  customerId: string;
  customerPhone: string;
  conversationId: string;
  conversationStartedAt: string;
  /** ISO del inicio de este turno ReAct (no reusar un pending abierto en el mismo loop). */
  turnStartedAt?: string;
  /** Identifica este turno para limitar resoluciones internas de catálogo. */
  turnId?: string;
  /** Texto del mensaje del usuario en este turno (validar quantity vs prosa). */
  userMessage?: string;
  /** Resolución validada entregada por el execution plan actual, no por el modelo. */
  validatedProductResolutionFromExecutionContext?: ProductResolution;
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
