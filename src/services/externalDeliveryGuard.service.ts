/**
 * Guardas del rol DELIVERY cuando el negocio usa delivery externo.
 * El rider propio no gestiona pedidos: no lista, no ve detalle, no cambia estados.
 */

export const EXTERNAL_DELIVERY_MANAGED_ERROR =
  'El delivery de este negocio está gestionado por un servicio externo';

export function isOwnDeliveryBlocked(params: {
  role: string | undefined;
  externalDeliveryEnabled: boolean;
}): boolean {
  return params.role === 'DELIVERY' && params.externalDeliveryEnabled;
}
