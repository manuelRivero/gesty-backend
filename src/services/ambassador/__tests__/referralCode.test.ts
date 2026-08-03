import { describe, expect, it } from 'vitest';
import {
  AMBASSADOR_REF_TTL_MS,
  extractReferralCode,
  isAmbassadorRefExpired,
} from '../referralCode';

describe('extractReferralCode', () => {
  it('extrae el código y sanea el texto cuando el mensaje es solo el token', () => {
    const result = extractReferralCode('DS_REF=AMB-7F3K9X');
    expect(result).toEqual({ code: 'AMB-7F3K9X', sanitizedText: '' });
  });

  it('normaliza el código a mayúsculas', () => {
    const result = extractReferralCode('ds_ref=amb-7f3k9x');
    expect(result?.code).toBe('AMB-7F3K9X');
  });

  it('acepta el separador `:` además de `=`', () => {
    const result = extractReferralCode('DS_REF:AMB-7F3K9X');
    expect(result?.code).toBe('AMB-7F3K9X');
  });

  it('tolera espacios alrededor del separador', () => {
    const result = extractReferralCode('DS_REF = AMB-7F3K9X');
    expect(result?.code).toBe('AMB-7F3K9X');
  });

  it('sanea el token dejando el resto del mensaje humano sin el DS_REF', () => {
    const result = extractReferralCode('Hola quiero pedir DS_REF=AMB-7F3K9X delivery por favor');
    expect(result?.code).toBe('AMB-7F3K9X');
    expect(result?.sanitizedText).not.toContain('DS_REF');
    expect(result?.sanitizedText).not.toContain('AMB-7F3K9X');
    expect(result?.sanitizedText).toContain('Hola quiero pedir');
    expect(result?.sanitizedText).toContain('delivery por favor');
  });

  it('devuelve null si no hay match', () => {
    expect(extractReferralCode('Hola, quiero hacer un pedido')).toBeNull();
  });

  it('devuelve null para texto vacío o ausente', () => {
    expect(extractReferralCode('')).toBeNull();
    expect(extractReferralCode(undefined)).toBeNull();
    expect(extractReferralCode(null)).toBeNull();
  });
});

describe('isAmbassadorRefExpired', () => {
  it('no expira dentro del TTL', () => {
    const now = new Date('2026-08-03T12:00:00Z');
    const validatedAt = new Date(now.getTime() - (AMBASSADOR_REF_TTL_MS - 1000)).toISOString();
    expect(isAmbassadorRefExpired(validatedAt, now)).toBe(false);
  });

  it('expira justo pasado el TTL', () => {
    const now = new Date('2026-08-03T12:00:00Z');
    const validatedAt = new Date(now.getTime() - (AMBASSADOR_REF_TTL_MS + 1000)).toISOString();
    expect(isAmbassadorRefExpired(validatedAt, now)).toBe(true);
  });

  it('trata timestamps inválidos como expirados', () => {
    expect(isAmbassadorRefExpired('not-a-date')).toBe(true);
  });
});
