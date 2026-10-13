/**
 * Speech-to-Text para audio del dueño (PLAN-ACCION-OWNER-AUDIO.md).
 *
 * Único punto de entrada: `transcribeOwnerAudio`. Mismo patrón de cuota que
 * `paymentProofVision.service.ts` (D6) — gate con `evaluateSubscriptionForBotAi`
 * + `getEffectiveAiTokenLimit` **antes** de llamar a OpenAI, e `incrementUsage`
 * tras un éxito con tokens reportados. Sin saldo / `ai_blocked` → no
 * transcribe, nunca lanza: devuelve un resultado tipado para que el nodo
 * caller decida el mensaje al dueño.
 *
 * D7: sin TTS. Solo transcripción de audio a texto.
 *
 * La llamada al proveedor vive en `audioTranscription.service.ts` (genérico).
 */

import type { business as Business } from '@prisma/client';
import { evaluateBusinessBillingAccess } from '../billing/evaluateBusinessBillingAccess.service';
import { resolveBusinessCapabilities } from '../billing/businessCapabilities.service';
import { getEffectiveAiTokenLimit } from './aiLimits';
import { incrementUsage } from './aiUsage.service';
import {
  AUDIO_TRANSCRIPTION_MODEL,
  AudioTranscriptionError,
  extensionForAudioMime,
  transcribeAudio,
} from './audioTranscription.service';

export const SPEECH_TO_TEXT_TIMEOUT_MS = 30_000;
export const SPEECH_TO_TEXT_MODEL = AUDIO_TRANSCRIPTION_MODEL;
export const SPEECH_TO_TEXT_MIN_TRANSCRIPT_CHARS = 2;

export type SpeechToTextOutcome =
  | { ok: true; transcript: string }
  | { ok: false; reason: 'no_quota' | 'empty' | 'stt_failed' };

/**
 * Gate de uso de IA del negocio (D6): mismo criterio que
 * `extractPaymentProofWithVision` — negocio bloqueado o sin cuota no dispara
 * el llamado a OpenAI. Corre ANTES de `aiCapabilityGateNode` en el grafo
 * (STT de audio del dueño normaliza a texto antes del gate de suscripción),
 * así que además resuelve explícitamente la capacidad comercial de IA
 * (PLAN-ACCION-SHOPPING-ONLY.md): un negocio Shopping Only con suscripción
 * activa no debe transcribir audio aunque la suscripción esté vigente.
 */
async function canUseSttForBusiness(business: Business): Promise<boolean> {
  if (business.ai_blocked) return false;

  const trialAccess = await evaluateBusinessBillingAccess(business);
  if (!trialAccess.ok) return false;

  const effectiveLimit = getEffectiveAiTokenLimit(trialAccess.business);
  if (trialAccess.business.ai_monthly_tokens_used >= effectiveLimit) return false;

  const capabilities = await resolveBusinessCapabilities(business.id);
  return capabilities.ai.allowed;
}

export const transcribeOwnerAudio = async (params: {
  business: Business;
  audioBuffer: Buffer;
  mimeType: string;
}): Promise<SpeechToTextOutcome> => {
  const { business, audioBuffer, mimeType } = params;

  const canUse = await canUseSttForBusiness(business).catch((error) => {
    console.error(
      JSON.stringify({
        event: '[speech-to-text] usage_gate_failed',
        businessId: business.id,
        error: String(error),
      })
    );
    return false;
  });
  if (!canUse) {
    console.log(
      JSON.stringify({ event: '[speech-to-text] skipped_no_quota', businessId: business.id })
    );
    return { ok: false, reason: 'no_quota' };
  }

  try {
    const result = await transcribeAudio({
      audioBuffer,
      mimeType,
      language: 'es',
      filename: `owner-audio.${extensionForAudioMime(mimeType)}`,
    });

    const totalTokens = result.usageTokens ?? 0;
    if (totalTokens > 0) {
      await incrementUsage(business.id, totalTokens).catch((error) => {
        console.error(
          JSON.stringify({
            event: '[speech-to-text] increment_usage_failed',
            businessId: business.id,
            error: String(error),
          })
        );
      });
    }

    return { ok: true, transcript: result.text };
  } catch (error) {
    if (error instanceof AudioTranscriptionError && error.code === 'EMPTY_TRANSCRIPT') {
      console.log(
        JSON.stringify({ event: '[speech-to-text] empty_transcript', businessId: business.id })
      );
      return { ok: false, reason: 'empty' };
    }
    console.error(
      JSON.stringify({
        event: '[speech-to-text] call_failed',
        businessId: business.id,
        error: String(error),
      })
    );
    return { ok: false, reason: 'stt_failed' };
  }
};
