/**
 * Transcripción de audio genérica (audio → texto).
 * NO conoce promociones ni WhatsApp.
 *
 * Proveedor: OpenAI `gpt-4o-mini-transcribe` (mismo que owner-audio).
 * El gate de cuota de IA del negocio queda en el caller
 * (`transcribeOwnerAudio`, endpoint admin de promociones).
 */

import OpenAI, { toFile } from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const AUDIO_TRANSCRIPTION_TIMEOUT_MS = 30_000;
export const AUDIO_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
export const AUDIO_TRANSCRIPTION_MIN_CHARS = 2;

export type TranscriptionInput = {
  audioBuffer: Buffer;
  mimeType: string;
  /** BCP-47 / ISO 639-1; default 'es'. */
  language?: string;
  /** Nombre lógico del archivo para el provider (extensión coherente con MIME). */
  filename?: string;
};

export type TranscriptionResult = {
  text: string;
  language?: string;
  duration?: number;
  /** Tokens reportados por el proveedor (para cuota IA del negocio). */
  usageTokens?: number;
};

export class AudioTranscriptionError extends Error {
  constructor(
    message: string,
    readonly code: 'EMPTY_TRANSCRIPT' | 'PROVIDER_FAILED'
  ) {
    super(message);
    this.name = 'AudioTranscriptionError';
  }
}

const MIME_TO_EXT: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
};

export function extensionForAudioMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(';')[0]!.trim();
  return MIME_TO_EXT[normalized] ?? 'ogg';
}

/**
 * Transcribe un buffer de audio. Lanza `AudioTranscriptionError` si falla
 * el proveedor o el transcript queda vacío.
 */
export async function transcribeAudio(
  input: TranscriptionInput
): Promise<TranscriptionResult> {
  const mimeType = input.mimeType.toLowerCase().split(';')[0]!.trim();
  const language = input.language ?? 'es';
  const ext = extensionForAudioMime(mimeType);
  const filename = input.filename ?? `admin-audio.${ext}`;

  try {
    const file = await toFile(input.audioBuffer, filename, { type: mimeType });

    const response = await openai.audio.transcriptions.create(
      {
        file,
        model: AUDIO_TRANSCRIPTION_MODEL,
        language,
      },
      { timeout: AUDIO_TRANSCRIPTION_TIMEOUT_MS }
    );

    const text = (response.text ?? '').trim();
    if (text.length < AUDIO_TRANSCRIPTION_MIN_CHARS) {
      throw new AudioTranscriptionError('Transcript vacío', 'EMPTY_TRANSCRIPT');
    }

    const duration =
      typeof (response as { duration?: number }).duration === 'number'
        ? (response as { duration?: number }).duration
        : undefined;

    const usageTokens =
      (response as unknown as { usage?: { total_tokens?: number } }).usage?.total_tokens ?? 0;

    return {
      text,
      language,
      ...(duration !== undefined ? { duration } : {}),
      ...(usageTokens > 0 ? { usageTokens } : {}),
    };
  } catch (error) {
    if (error instanceof AudioTranscriptionError) throw error;
    console.error(
      JSON.stringify({
        event: '[audio-transcription] call_failed',
        error: String(error),
      })
    );
    throw new AudioTranscriptionError('Fallo del proveedor STT', 'PROVIDER_FAILED');
  }
}
