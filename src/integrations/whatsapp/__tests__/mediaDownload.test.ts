import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envState: Record<string, string | undefined> = {
  WHATSAPP_ACCESS_TOKEN: 'test-token',
};

vi.mock('../../../config/env', () => ({
  env: new Proxy(
    {},
    {
      get: (_t, prop: string) => envState[prop],
    }
  ),
}));

import {
  ALLOWED_INBOUND_MEDIA_MIMES,
  MAX_INBOUND_MEDIA_BYTES,
  WHATSAPP_GRAPH_BASE_URL,
  WhatsAppMediaError,
  downloadWhatsAppMedia,
} from '../mediaDownload';

// Header PNG válido (8 bytes) + relleno para pasar el mínimo de detección de magic bytes.
const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function bufferResponse(buffer: Buffer, ok = true, status = 200): Response {
  return {
    ok,
    status,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    text: async () => '',
  } as unknown as Response;
}

describe('downloadWhatsAppMedia', () => {
  beforeEach(() => {
    envState.WHATSAPP_ACCESS_TOKEN = 'test-token';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hace los dos requests, ambos con header Authorization, y devuelve el buffer', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        url: 'https://lookaside.fbsbx.com/whatsapp_media/abc?token=xyz',
        mime_type: 'image/png',
        sha256: 'deadbeef',
        file_size: PNG_MAGIC.length,
        id: 'media-1',
      })
    );
    fetchMock.mockResolvedValueOnce(bufferResponse(PNG_MAGIC));
    vi.stubGlobal('fetch', fetchMock);

    const result = await downloadWhatsAppMedia('media-1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${WHATSAPP_GRAPH_BASE_URL}/media-1`,
      { headers: { Authorization: 'Bearer test-token' } }
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining('lookaside.fbsbx.com'), {
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(result.mimeType).toBe('image/png');
    expect(result.sha256).toBe('deadbeef');
    expect(result.buffer.equals(PNG_MAGIC)).toBe(true);
    expect(ALLOWED_INBOUND_MEDIA_MIMES).toContain(result.mimeType);
  });

  it('rechaza un file_size sobre el tope sin bajar los bytes', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        url: 'https://lookaside.fbsbx.com/whatsapp_media/abc',
        mime_type: 'image/png',
        sha256: 'deadbeef',
        file_size: MAX_INBOUND_MEDIA_BYTES + 1,
        id: 'media-2',
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadWhatsAppMedia('media-2')).rejects.toMatchObject({
      code: 'MEDIA_TOO_LARGE',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rechaza un MIME no permitido detectado por magic bytes', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        url: 'https://lookaside.fbsbx.com/whatsapp_media/abc',
        mime_type: 'image/png',
        sha256: 'deadbeef',
        file_size: 20,
        id: 'media-3',
      })
    );
    const fakePdf = Buffer.from('%PDF-1.4 no es una imagen real............');
    fetchMock.mockResolvedValueOnce(bufferResponse(fakePdf));
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadWhatsAppMedia('media-3')).rejects.toMatchObject({
      code: 'MEDIA_UNSUPPORTED_TYPE',
    });
  });

  it('lanza WhatsAppMediaError si falla el request de metadata', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, false, 404));
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadWhatsAppMedia('media-4')).rejects.toBeInstanceOf(WhatsAppMediaError);
  });
});
