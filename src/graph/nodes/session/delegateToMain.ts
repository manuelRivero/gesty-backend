/**
 * Helper compartido entre los nodos de sesión (checkout, reservas, onboarding)
 * para la señal `delegate_to_main`: invoca al híbrido inline sin limpiar la
 * sesión activa.
 *
 * Corre `detectIntentWithConfidence` con el mensaje del turno antes de invocar
 * al híbrido, igual que ya hacía `invokeHybridAfterCheckoutHandback` para
 * `handback_to_main` — así el híbrido recibe `detection` real (mejores CTAs)
 * en vez de degradar a texto plano por falta de detección (H-01).
 */

import { detectIntentWithConfidence } from '../../../services/ai/detection.service';
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
  const { enrichedCtx, userMessage, detectionContext } = params;

  let hybridCtx = enrichedCtx;
  if (detectionContext && userMessage.trim()) {
    const detection = await detectIntentWithConfidence(userMessage, detectionContext);
    hybridCtx = { ...enrichedCtx, detection };
  }

  const hybrid = await runHybridReactAgent(hybridCtx);
  if (hybrid?.kind === 'response') {
    return { handlerResult: hybrid.handlerResult, discardedReentrySignal: false };
  }
  return { handlerResult: null, discardedReentrySignal: hybrid?.kind === 'delegate_checkout' };
};
