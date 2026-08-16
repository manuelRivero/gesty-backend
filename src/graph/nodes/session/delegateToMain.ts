/**
 * Helper compartido entre los nodos de sesión (checkout, reservas, onboarding)
 * para la señal `delegate_to_main`: invoca al híbrido inline sin limpiar la
 * sesión activa. Sin clasificador de intent: CTAs salen de tools.
 */

import type { DetectionContext } from '../../../services/ai/detection.service';
import { runHybridReactAgent } from '../../../agents/reactAgent';
import type { EnrichedContext, HandlerResult } from '../../../controllers/webhook/types';

export interface DelegateToMainResult {
  handlerResult: HandlerResult | null;
  /**
   * `true` cuando el híbrido respondió con una señal de re-entrada
   * (`delegate_checkout`) en vez de texto — el mecanismo anti-loop correcto
   * (no se puede iniciar/tocar el checkout desde una sesión ya activa), pero
   * que antes se descartaba en silencio dejando la acción del usuario sin
   * respuesta (H-07). El nodo debe explicar el motivo en vez de usar el
   * texto residual del agente de sesión.
   */
  discardedReentrySignal: boolean;
}

export const delegateToMainWithDetection = async (params: {
  enrichedCtx: EnrichedContext;
  userMessage: string;
  detectionContext: DetectionContext | null | undefined;
}): Promise<DelegateToMainResult> => {
  const { enrichedCtx, userMessage } = params;

  if (!userMessage.trim()) {
    return { handlerResult: null, discardedReentrySignal: false };
  }

  const hybrid = await runHybridReactAgent(enrichedCtx);
  if (hybrid?.kind === 'response') {
    return { handlerResult: hybrid.handlerResult, discardedReentrySignal: false };
  }
  return { handlerResult: null, discardedReentrySignal: hybrid?.kind === 'delegate_checkout' };
};
