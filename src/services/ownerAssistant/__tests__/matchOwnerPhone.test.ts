import { describe, expect, it } from 'vitest';
import {
  isOwnerPhone,
  normalizePhoneDigits,
  sanitizeOwnerPhones,
} from '../matchOwnerPhone';

describe('normalizePhoneDigits', () => {
  it('saca +, espacios y guiones', () => {
    expect(normalizePhoneDigits('+54 9 11 1234-5678')).toBe('5491112345678');
  });
});

describe('sanitizeOwnerPhones', () => {
  it('fail closed: lista vacía o basura', () => {
    expect(sanitizeOwnerPhones([])).toEqual([]);
    expect(sanitizeOwnerPhones(['123', 'abc'])).toEqual([]);
  });

  it('deduplica por dígitos y descarta inválidos', () => {
    expect(
      sanitizeOwnerPhones(['+5491112345678', '5491112345678', '12', '5491199999999'])
    ).toEqual(['5491112345678', '5491199999999']);
  });
});

describe('isOwnerPhone', () => {
  it('no matchea si la allowlist está vacía', () => {
    expect(isOwnerPhone('5491112345678', [])).toBe(false);
    expect(isOwnerPhone('5491112345678', null)).toBe(false);
  });

  it('matchea el mismo número con o sin +', () => {
    expect(isOwnerPhone('+5491112345678', ['5491112345678'])).toBe(true);
    expect(isOwnerPhone('5491112345678', ['+54 911 1234 5678'])).toBe(true);
  });

  it('no matchea otro teléfono', () => {
    expect(isOwnerPhone('5491100000000', ['5491112345678'])).toBe(false);
  });
});
