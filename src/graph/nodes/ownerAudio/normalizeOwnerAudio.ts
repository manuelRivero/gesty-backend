/**
 * `normalizeOwnerAudio` (PLAN-ACCION-OWNER-AUDIO.md).
 *
 * Corre entre `businessOpenInfo` y `persistUserMessage`. Si el remitente es
 * el dueño autorizado (`isOwnerAssistant`) y el mensaje entrante es audio,
 * descarga el adjunto (D8), lo transcribe (D6: gate de cuota de IA antes del
 * llamado a OpenAI) y **muta** `webhookContext.message` a un mensaje de
 * texto normal con el transcript. A partir de ahí el resto del grafo procesa
 * el turno exactamente igual que un texto del dueño — mismo pipeline,
 * `owner_assistant` (objetivo rector del plan).
 *
 * D4 — idempotencia: chequea `findByExternalMessageId(message.id)` antes de
 * cualquier I/O caro. Un webhook reintentado con el mismo `wamid` no vuelve
 * a gastar descarga/STT ni a duplicar la respuesta: corta directo a `END`.
 *
 * No-op (deja el mensaje intacto) en cualquier otro caso: no es dueño, o el
 * mensaje no es audio. El guard de tipos (`messageTypeGuard`) sigue
 * rechazando audio de clientes exactamente igual que hoy.
 *
 * D2 — sin metadata en `conversation_message`: la trazabilidad es solo estos
 * logs estructurados mínimos.
 */

import { findByExternalMessageId } from '../../../repositories';
import {
  downloadWhatsAppAudio,
  WhatsAppMediaError,
} from '../../../integrations/whatsapp/mediaDownload';
import {
  transcribeOwnerAudio,
  SPEECH_TO_TEXT_MODEL,
} from '../../../services/ai/speechToText.service';
import type { AgentState, AgentStateUpdate } from '../../state';

type FailureOutcome =
  | 'download_failed'
  | 'unsupported_mime'
  | 'too_large'
  | 'no_quota'
  | 'stt_failed'
  | 'empty';

const FAILURE_MESSAGES: Record<FailureOutcome, string> = {
  download_failed:
    '🤖\n\nNo pude descargar tu audio 🙏\n\n¿Podés escribirme el mensaje?',
  unsupported_mime:
    '🤖\n\nNo pude leer el formato de ese audio 🙏\n\n¿Podés escribirme el mensaje?',
  too_large:
    '🤖\n\nEse audio es demasiado pesado 🙏\n\n¿Podés mandar uno más corto o escribirme el mensaje?',
  no_quota:
    '🤖\n\nSe agotó la cuota de IA del negocio este mes, así que no puedo transcribir audios ahora 🙏\n\nEscribime el mensaje y te ayudo igual.',
  stt_failed:
    '🤖\n\nNo pude transcribir tu audio 🙏\n\n¿Podés escribirme el mensaje?',
  empty:
    '🤖\n\nNo llegué a entender el audio (sonó vacío o muy corto) 🙏\n\n¿Podés escribirme el mensaje?',
};

const logEvent = (data: Record<string, unknown>): void => {
  console.log(JSON.stringify({ event: '[owner-audio] transcribed', ...data }));
};

const logError = (event: string, data: Record<string, unknown>): void => {
  console.error(JSON.stringify({ event: `[owner-audio] ${event}`, ...data }));
};

const mediaErrorToOutcome = (error: unknown): FailureOutcome => {
  if (error instanceof WhatsAppMediaError) {
    if (error.code === 'MEDIA_TOO_LARGE') return 'too_large';
    if (error.code === 'MEDIA_UNSUPPORTED_TYPE') return 'unsupported_mime';
  }
  return 'download_failed';
};

export const normalizeOwnerAudioNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const ctx = state.webhookContext;
  const message = ctx?.message;
  const isAudioMessage =
    Boolean(message) && typeof message.type === 'string' && message.type === 'audio';

  if (!state.isOwnerAssistant || !isAudioMessage) {
    return {};
  }

  const wamid: string | undefined = message?.id;
  const mediaId: string | undefined = message?.audio?.id;
  const business = state.business;

  if (!mediaId || !business) {
    logError('missing_context', {
      wamid,
      hasMediaId: Boolean(mediaId),
      hasBusiness: Boolean(business),
    });
    return { ownerAudioBlockedMessage: FAILURE_MESSAGES.download_failed };
  }

  if (wamid) {
    const existing = await findByExternalMessageId(wamid).catch((error) => {
      logError('duplicate_check_failed', { wamid, error: String(error) });
      return null;
    });
    if (existing) {
      logEvent({ outcome: 'duplicate', conversationId: state.conversationId, wamid, mediaId });
      return { earlyExit: 'owner_audio_duplicate' };
    }
  }

  let media: Awaited<ReturnType<typeof downloadWhatsAppAudio>>;
  try {
    media = await downloadWhatsAppAudio(mediaId);
  } catch (error) {
    const outcome = mediaErrorToOutcome(error);
    logEvent({
      outcome,
      conversationId: state.conversationId,
      wamid,
      mediaId,
      error: String(error),
    });
    return { ownerAudioBlockedMessage: FAILURE_MESSAGES[outcome] };
  }

  const sttResult = await transcribeOwnerAudio({
    business,
    audioBuffer: media.buffer,
    mimeType: media.mimeType,
  });

  if (!sttResult.ok) {
    logEvent({
      outcome: sttResult.reason,
      conversationId: state.conversationId,
      wamid,
      mediaId,
      mime: media.mimeType,
    });
    return { ownerAudioBlockedMessage: FAILURE_MESSAGES[sttResult.reason] };
  }

  logEvent({
    outcome: 'ok',
    conversationId: state.conversationId,
    wamid,
    mediaId,
    mime: media.mimeType,
    sttModel: SPEECH_TO_TEXT_MODEL,
    transcriptChars: sttResult.transcript.length,
  });

  return {
    webhookContext: {
      ...ctx!,
      message: {
        ...message,
        type: 'text',
        text: { body: sttResult.transcript },
      },
    },
  };
};
