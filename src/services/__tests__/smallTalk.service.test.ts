import { describe, expect, it } from 'vitest';
import {
  buildWelcomeShortcutBullets,
  welcomeShortcutBullet,
} from '../smallTalk.service';

describe('smallTalk welcome shortcuts', () => {
  it('mapea payloads base a atajos tipables', () => {
    expect(
      welcomeShortcutBullet({ title: 'Hacer un pedido', payload: 'ORDER_FOOD' })
    ).toBe('• *Hacer* pedido');
    expect(welcomeShortcutBullet({ title: 'Ver menú', payload: 'VIEW_MENU' })).toBe(
      '• *Menú*'
    );
    expect(
      welcomeShortcutBullet({
        title: 'Horarios de atención',
        payload: 'BUSINESS_HOURS',
      })
    ).toBe('• *Horarios*');
    expect(
      welcomeShortcutBullet({
        title: 'Hacer una consulta',
        payload: 'ASK_QUESTION',
      })
    ).toBe('• *Consulta*');
  });

  it('incluye opcionales en el mismo orden que los botones', () => {
    const bullets = buildWelcomeShortcutBullets([
      { title: 'Ver pedido', payload: 'VIEW_CART' },
      { title: 'Hacer un pedido', payload: 'ORDER_FOOD' },
      { title: 'Ver menú', payload: 'VIEW_MENU' },
      { title: 'Reservar mesa', payload: 'VIEW_RESERVATION' },
      { title: 'Editar dirección', payload: 'EDIT_ADDRESS' },
    ]);
    expect(bullets).toEqual([
      '• Ver *pedido*',
      '• *Hacer* pedido',
      '• *Menú*',
      '• *Reservar* mesa',
      '• *Editar* dirección',
    ]);
  });
});
