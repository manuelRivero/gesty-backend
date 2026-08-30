/**
 * Tarea 4.5 (PLAN-ACCION-VARIACIONES-PLATILLOS.md): con variaciones, un
 * producto puede ocupar dos líneas del carrito. Los payloads de los botones
 * pasaron a llevar el id de la LÍNEA; los que ya están en el teléfono del
 * cliente llevan el del producto y tienen que seguir resolviendo.
 */

import { describe, expect, it } from 'vitest';
import { cartLineLabel, findCartLineByPayloadId } from '../cart.service';

const ESPECIAL = {
  id: 'line-especial',
  product_id: 'pizza',
  variation: 'Especial',
  menu_item: { name: 'Pizza' },
};
const ROQUEFORT = {
  id: 'line-roquefort',
  product_id: 'pizza',
  variation: 'Roquefort',
  menu_item: { name: 'Pizza' },
};
const LINES = [ESPECIAL, ROQUEFORT];

describe('findCartLineByPayloadId', () => {
  it('resuelve la línea exacta cuando el payload trae el id de línea', () => {
    expect(findCartLineByPayloadId(LINES, 'line-roquefort')).toBe(ROQUEFORT);
    expect(findCartLineByPayloadId(LINES, 'line-especial')).toBe(ESPECIAL);
  });

  it('cae al producto para los payloads viejos, ya emitidos al cliente', () => {
    expect(findCartLineByPayloadId(LINES, 'pizza')).toBe(ESPECIAL);
  });

  it('devuelve undefined si el id no está en el carrito', () => {
    expect(findCartLineByPayloadId(LINES, 'otra-cosa')).toBeUndefined();
  });

  it('prefiere la línea aunque exista un producto con ese mismo id', () => {
    const colision = [{ id: 'x', product_id: 'y' }, { id: 'z', product_id: 'x' }];
    expect(findCartLineByPayloadId(colision, 'x')).toBe(colision[0]);
  });
});

describe('cartLineLabel', () => {
  it('pega la variación al nombre para que dos filas del mismo plato se distingan', () => {
    expect(cartLineLabel(ESPECIAL)).toBe('Pizza (Especial)');
    expect(cartLineLabel(ROQUEFORT)).toBe('Pizza (Roquefort)');
  });

  it('sin variación deja el nombre igual que antes', () => {
    expect(cartLineLabel({ variation: null, menu_item: { name: 'Milanesa' } })).toBe('Milanesa');
    expect(cartLineLabel({ variation: '  ', menu_item: { name: 'Milanesa' } })).toBe('Milanesa');
  });
});
