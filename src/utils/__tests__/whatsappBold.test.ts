import { describe, it, expect } from 'vitest';
import {
  normalizeWhatsAppBoldMarkers,
  stripWhatsAppBoldMarkers,
  wrapWhatsAppBold,
} from '../whatsappBold';

describe('whatsappBold', () => {
  it('strip quita asteriscos previos', () => {
    expect(stripWhatsAppBoldMarkers('*Menú*')).toBe('Menú');
    expect(stripWhatsAppBoldMarkers('**Menú**')).toBe('Menú');
    expect(stripWhatsAppBoldMarkers('  *Ver* pedido ')).toBe('Ver pedido');
  });

  it('wrap es idempotente', () => {
    expect(wrapWhatsAppBold('Menú')).toBe('*Menú*');
    expect(wrapWhatsAppBold('*Menú*')).toBe('*Menú*');
    expect(wrapWhatsAppBold('**Menú**')).toBe('*Menú*');
  });

  it('normalize convierte Markdown y dobles', () => {
    expect(normalizeWhatsAppBoldMarkers('probá **ceviche** hoy')).toBe(
      'probá *ceviche* hoy'
    );
    expect(normalizeWhatsAppBoldMarkers('* *ceviche* *')).toBe('*ceviche*');
    expect(normalizeWhatsAppBoldMarkers('***hola***')).toBe('*hola*');
  });
});
