/**
 * Referente informativo de producto (Fase 2 — continuidad conversacional).
 * Unit tests del servicio: ciclo de vida (fijar, expirar, reemplazar) y la
 * línea de contexto, sin pasar por las tools.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const patchConversationMetadata = vi.fn();

vi.mock('../../repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories')>();
  return {
    ...actual,
    patchConversationMetadata: (...args: unknown[]) => patchConversationMetadata(...args),
  };
});

import {
  buildInformationalProductRefContextLines,
  getApplicableInformationalProductRef,
  getInformationalProductRef,
  rememberInformationalProductRef,
} from '../informationalProductRef.service';
import { PRODUCT_RESOLUTION_TTL_MS } from '../productResolution.service';

const PRODUCT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRODUCT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('informationalProductRef.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    patchConversationMetadata.mockResolvedValue(undefined);
  });

  it('getInformationalProductRef devuelve null sin referente', () => {
    expect(getInformationalProductRef({})).toBeNull();
  });

  it('rememberInformationalProductRef persiste productId, name y un TTL igual al de ProductResolution', async () => {
    const before = Date.now();
    await rememberInformationalProductRef('conv-1', { productId: PRODUCT_A, name: 'Ceviche Clásico' });

    expect(patchConversationMetadata).toHaveBeenCalledTimes(1);
    const [conversationId, patch] = patchConversationMetadata.mock.calls[0];
    expect(conversationId).toBe('conv-1');
    const ref = (patch as Record<string, unknown>).lastInformationalProductRef as {
      productId: string;
      name: string;
      setAt: string;
      expiresAt: string;
    };
    expect(ref.productId).toBe(PRODUCT_A);
    expect(ref.name).toBe('Ceviche Clásico');
    const ttl = Date.parse(ref.expiresAt) - Date.parse(ref.setAt);
    expect(ttl).toBe(PRODUCT_RESOLUTION_TTL_MS);
    expect(Date.parse(ref.setAt)).toBeGreaterThanOrEqual(before);
  });

  it('getInformationalProductRef lee un referente vigente', () => {
    const now = Date.now();
    const metadata = {
      lastInformationalProductRef: {
        productId: PRODUCT_A,
        name: 'Ceviche Clásico',
        setAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
      },
    };
    expect(getInformationalProductRef(metadata)).toEqual({
      productId: PRODUCT_A,
      name: 'Ceviche Clásico',
      setAt: metadata.lastInformationalProductRef.setAt,
      expiresAt: metadata.lastInformationalProductRef.expiresAt,
    });
  });

  it('getInformationalProductRef descarta un referente vencido', () => {
    const now = Date.now();
    const metadata = {
      lastInformationalProductRef: {
        productId: PRODUCT_A,
        name: 'Ceviche Clásico',
        setAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now - 1_000).toISOString(),
      },
    };
    expect(getInformationalProductRef(metadata)).toBeNull();
  });

  it('getInformationalProductRef descarta un registro corrupto/incompleto sin inventar datos', () => {
    expect(getInformationalProductRef({ lastInformationalProductRef: { productId: PRODUCT_A } })).toBeNull();
    expect(getInformationalProductRef({ lastInformationalProductRef: 'no-es-un-objeto' })).toBeNull();
  });

  it('buildInformationalProductRefContextLines no genera nada sin referente', () => {
    expect(buildInformationalProductRefContextLines({})).toEqual([]);
  });

  it('buildInformationalProductRefContextLines menciona el producto y aclara que no es oferta ni selección', () => {
    const now = Date.now();
    const metadata = {
      lastInformationalProductRef: {
        productId: PRODUCT_B,
        name: 'Milanesa Napolitana',
        setAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
      },
    };
    const lines = buildInformationalProductRefContextLines(metadata);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Milanesa Napolitana');
    expect(lines[0]).toContain(PRODUCT_B);
    expect(lines[0]).toMatch(/NO es oferta ni selección/);
  });

  it('buildInformationalProductRefContextLines se omite si hay una selección pendiente activa (ambigüedad con prioridad)', () => {
    const now = Date.now();
    const metadata = {
      pendingProductSelection: true,
      lastInformationalProductRef: {
        productId: PRODUCT_A,
        name: 'Ceviche Clásico',
        setAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
      },
    };
    expect(buildInformationalProductRefContextLines(metadata)).toEqual([]);
  });

  it('getApplicableInformationalProductRef devuelve el referente vigente sin selección pendiente', () => {
    const now = Date.now();
    const metadata = {
      lastInformationalProductRef: {
        productId: PRODUCT_A,
        name: 'Ceviche Clásico',
        setAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
      },
    };
    expect(getApplicableInformationalProductRef(metadata)).toMatchObject({ productId: PRODUCT_A });
  });

  it('getApplicableInformationalProductRef devuelve null si hay una selección pendiente (ambigüedad con prioridad), aunque el referente esté vigente', () => {
    const now = Date.now();
    const metadata = {
      pendingProductSelection: true,
      lastInformationalProductRef: {
        productId: PRODUCT_A,
        name: 'Ceviche Clásico',
        setAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
      },
    };
    expect(getApplicableInformationalProductRef(metadata)).toBeNull();
  });

  it('getApplicableInformationalProductRef devuelve null si el referente venció', () => {
    const now = Date.now();
    const metadata = {
      lastInformationalProductRef: {
        productId: PRODUCT_A,
        name: 'Ceviche Clásico',
        setAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now - 1_000).toISOString(),
      },
    };
    expect(getApplicableInformationalProductRef(metadata)).toBeNull();
  });
});
