/**
 * Nodo `ambassadorReferral`: detecta y valida el código de Embajador de
 * Domingo Sabrosón (`DS_REF=AMB-XXXXXX`) que llega en el mensaje inicial de
 * WhatsApp cuando el cliente escanea el QR de un embajador.
 *
 * Corre entre `escalationGate` y `buildDetectionContext`: para ese punto el
 * mensaje crudo ya se persistió en el historial y ya pasaron todos los gates
 * (suscripción, tipo de mensaje, escalamiento), así que no se gasta una
 * llamada HTTP externa en turnos que igual se iban a descartar.
 *
 * Nunca corta el flujo ni responde nada sobre el embajador: es transparente
 * para el cliente. Si el código es inválido o la API de Domingo Sabrosón
 * falla, el turno sigue exactamente igual que si no hubiera código.
 */

import { validateAmbassadorCode } from '../../../integrations/ambassadors/client';
import { extractReferralCode } from '../../../services/ambassador/referralCode';
import { patchConversationMetadata } from '../../../repositories/conversationState.repository';
import type { AgentState, AgentStateUpdate } from '../../state';

export const ambassadorReferralNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const ctx = state.webhookContext;
  const conversationId = state.conversationId;
  const businessConfig = state.businessConfig;

  if (!ctx || !conversationId || !businessConfig?.ambassadors_enabled) {
    return {};
  }

  const message = ctx.message;
  if (!message || message.type !== 'text') {
    return {};
  }

  const rawText: string | undefined = message.text?.body;
  const extracted = extractReferralCode(rawText);
  if (!extracted) {
    return {};
  }

  const { code, sanitizedText } = extracted;

  // Siempre saneamos el texto que ve el resto del pipeline (NLP, agentes),
  // sea o no válido el código: el cliente nunca debería tener que lidiar con
  // el token técnico si lo escribió a mano junto a un mensaje real.
  const sanitizedWebhookContext = {
    ...ctx,
    message: {
      ...message,
      text: { ...message.text, body: sanitizedText },
    },
  };

  try {
    const result = await validateAmbassadorCode(code);
    if (result.valid) {
      await patchConversationMetadata(conversationId, {
        ambassador_ref: { code: result.publicCode, validatedAt: new Date().toISOString() },
      });
      console.log('[AmbassadorReferral] Código válido, referencia guardada', {
        conversationId,
        publicCode: result.publicCode,
      });
    } else {
      console.log('[AmbassadorReferral] Código inválido, se ignora', { conversationId, code });
    }
  } catch (error) {
    // Un fallo de la API de Embajadores nunca debe romper la conversación.
    console.error('[AmbassadorReferral] Error al validar código, se ignora', {
      conversationId,
      code,
      error,
    });
  }

  return { webhookContext: sanitizedWebhookContext };
};
