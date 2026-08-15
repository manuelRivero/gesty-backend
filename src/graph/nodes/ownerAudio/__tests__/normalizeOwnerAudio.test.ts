/**
 * PLAN-ACCION-OWNER-AUDIO.md — nodo `normalizeOwnerAudio`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../repositories', () => ({
  findByExternalMessageId: vi.fn(),
}));

vi.mock('../../../../integrations/whatsapp/mediaDownload', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../integrations/whatsapp/mediaDownload')
  >('../../../../integrations/whatsapp/mediaDownload');
  return {
    ...actual,
    downloadWhatsAppAudio: vi.fn(),
  };
});

vi.mock('../../../../services/ai/speechToText.service', () => ({
  transcribeOwnerAudio: vi.fn(),
  SPEECH_TO_TEXT_MODEL: 'gpt-4o-mini-transcribe',
}));

import { normalizeOwnerAudioNode } from '../normalizeOwnerAudio';
import { findByExternalMessageId } from '../../../../repositories';
import {
  downloadWhatsAppAudio,
  WhatsAppMediaError,
} from '../../../../integrations/whatsapp/mediaDownload';
import { transcribeOwnerAudio } from '../../../../services/ai/speechToText.service';
import type { AgentState } from '../../../state';

const mockedFindByExternalMessageId = findByExternalMessageId as unknown as ReturnType<typeof vi.fn>;
const mockedDownloadWhatsAppAudio = downloadWhatsAppAudio as unknown as ReturnType<typeof vi.fn>;
const mockedTranscribeOwnerAudio = transcribeOwnerAudio as unknown as ReturnType<typeof vi.fn>;

const baseState = (overrides: Partial<AgentState> = {}): AgentState =>
  ({
    conversationId: 'conv-1',
    business: { id: 'biz-1' } as never,
    isOwnerAssistant: true,
    webhookContext: {
      message: { type: 'audio', id: 'wamid.1', audio: { id: 'media-1' } },
    } as never,
    ...overrides,
  }) as AgentState;

describe('normalizeOwnerAudioNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFindByExternalMessageId.mockResolvedValue(null);
  });

  it('no-op si el remitente no es el dueño', async () => {
    const result = await normalizeOwnerAudioNode(baseState({ isOwnerAssistant: false }));
    expect(result).toEqual({});
    expect(mockedDownloadWhatsAppAudio).not.toHaveBeenCalled();
  });

  it('no-op si el mensaje no es de tipo audio', async () => {
    const result = await normalizeOwnerAudioNode(
      baseState({ webhookContext: { message: { type: 'text', text: { body: 'hola' } } } as never })
    );
    expect(result).toEqual({});
    expect(mockedDownloadWhatsAppAudio).not.toHaveBeenCalled();
  });

  it('corta a END sin re-transcribir si el wamid ya fue procesado (D4)', async () => {
    mockedFindByExternalMessageId.mockResolvedValueOnce({ id: 'msg-1' });

    const result = await normalizeOwnerAudioNode(baseState());

    expect(result).toEqual({ earlyExit: 'owner_audio_duplicate' });
    expect(mockedDownloadWhatsAppAudio).not.toHaveBeenCalled();
    expect(mockedTranscribeOwnerAudio).not.toHaveBeenCalled();
  });

  it('muta webhookContext.message a texto con el transcript en éxito', async () => {
    mockedDownloadWhatsAppAudio.mockResolvedValueOnce({
      buffer: Buffer.from('fake'),
      mimeType: 'audio/ogg',
      sha256: 'abc',
      sizeBytes: 4,
    });
    mockedTranscribeOwnerAudio.mockResolvedValueOnce({ ok: true, transcript: 'cuánto vendí hoy' });

    const result = await normalizeOwnerAudioNode(baseState());

    expect(result.earlyExit).toBeUndefined();
    expect(result.ownerAudioBlockedMessage).toBeUndefined();
    expect((result.webhookContext as any)?.message).toEqual({
      type: 'text',
      id: 'wamid.1',
      audio: { id: 'media-1' },
      text: { body: 'cuánto vendí hoy' },
    });
  });

  it('setea ownerAudioBlockedMessage si falla la descarga', async () => {
    mockedDownloadWhatsAppAudio.mockRejectedValueOnce(
      new WhatsAppMediaError('MEDIA_DOWNLOAD_FAILED', 'boom')
    );

    const result = await normalizeOwnerAudioNode(baseState());

    expect(result.earlyExit).toBeUndefined();
    expect(result.ownerAudioBlockedMessage).toBeTruthy();
    expect(mockedTranscribeOwnerAudio).not.toHaveBeenCalled();
  });

  it('setea ownerAudioBlockedMessage si el audio es demasiado grande', async () => {
    mockedDownloadWhatsAppAudio.mockRejectedValueOnce(
      new WhatsAppMediaError('MEDIA_TOO_LARGE', 'boom')
    );

    const result = await normalizeOwnerAudioNode(baseState());

    expect(result.ownerAudioBlockedMessage).toContain('pesado');
  });

  it('setea ownerAudioBlockedMessage si STT no tiene cuota', async () => {
    mockedDownloadWhatsAppAudio.mockResolvedValueOnce({
      buffer: Buffer.from('fake'),
      mimeType: 'audio/ogg',
      sha256: 'abc',
      sizeBytes: 4,
    });
    mockedTranscribeOwnerAudio.mockResolvedValueOnce({ ok: false, reason: 'no_quota' });

    const result = await normalizeOwnerAudioNode(baseState());

    expect(result.ownerAudioBlockedMessage).toContain('cuota');
    expect((result as any).webhookContext).toBeUndefined();
  });

  it('setea ownerAudioBlockedMessage si el transcript queda vacío', async () => {
    mockedDownloadWhatsAppAudio.mockResolvedValueOnce({
      buffer: Buffer.from('fake'),
      mimeType: 'audio/ogg',
      sha256: 'abc',
      sizeBytes: 4,
    });
    mockedTranscribeOwnerAudio.mockResolvedValueOnce({ ok: false, reason: 'empty' });

    const result = await normalizeOwnerAudioNode(baseState());

    expect(result.ownerAudioBlockedMessage).toBeTruthy();
  });
});
