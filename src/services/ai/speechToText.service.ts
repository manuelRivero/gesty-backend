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
 */

import OpenAI, { toFile } from 'openai';
import type { business as Business } from '@prisma/client';
import { evaluateSubscriptionForBotAi } from '../subscriptionBotAccess.service';
import { getEffectiveAiTokenLimit } from './aiLimits';
import { incrementUsage } from './aiUsage.service';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const SPEECH_TO_TEXT_TIMEOUT_MS = 30_000;
export const SPEECH_TO_TEXT_MODEL = 'gpt-4o-mini-transcribe';
export const SPEECH_TO_TEXT_MIN_TRANSCRIPT_CHARS = 2;

export type SpeechToTextOutcome =
  | { ok: true; transcript: string }
  | { ok: false; reason: 'no_quota' | 'empty' | 'stt_failed' };

const MIME_TO_EXT: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
};

/**
 * Gate de uso de IA del negocio (D6): mismo criterio que
 * `extractPaymentProofWithVision` — negocio bloqueado o sin cuota no dispara
 * el llamado a OpenAI.
 */
async function canUseSttForBusiness(business: Business): Promise<boolean> {
  if (business.ai_blocked) return false;

  const trialAccess = await evaluateSubscriptionForBotAi(business);
  if (!trialAccess.ok) return false;

  const effectiveLimit = getEffectiveAiTokenLimit(trialAccess.business);
  if (trialAccess.business.ai_monthly_tokens_used >= effectiveLimit) return false;

  return true;
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
    const ext = MIME_TO_EXT[mimeType] ?? 'ogg';
    const file = await toFile(audioBuffer, `owner-audio.${ext}`, { type: mimeType });

    const response = await openai.audio.transcriptions.create(
      {
        file,
        model: SPEECH_TO_TEXT_MODEL,
        language: 'es',
      },
      { timeout: SPEECH_TO_TEXT_TIMEOUT_MS }
    );

    const totalTokens =
      (response as unknown as { usage?: { total_tokens?: number } }).usage?.total_tokens ?? 0;
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

    const transcript = (response.text ?? '').trim();
    if (transcript.length < SPEECH_TO_TEXT_MIN_TRANSCRIPT_CHARS) {
      console.log(
        JSON.stringify({ event: '[speech-to-text] empty_transcript', businessId: business.id })
      );
      return { ok: false, reason: 'empty' };
    }

    return { ok: true, transcript };
  } catch (error) {
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
