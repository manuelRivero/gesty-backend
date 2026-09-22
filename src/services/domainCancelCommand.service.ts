/**
 * Comando de cancelar pedido / cancelar reserva: el wipe es del dominio
 * nombrado, no del agente que tiene el turno.
 *
 * Payloads de botón y tipables de título fijo (Cancelar pedido / Cancelar
 * reserva). No intercepta prosa de variación/cantidad.
 */

export type DomainCancelTarget = 'order' | 'reservation';

const ORDER_PAYLOADS = new Set([
  'CANCEL_ORDER',
  'CANCEL_TARGET:draft',
  'CANCEL_TARGET:order',
  'CANCEL_CHECKOUT',
]);

const RESERVATION_PAYLOADS = new Set(['RESERVATION_CANCEL']);

const normalizeCommandText = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');

export const resolveDomainCancelCommand = (params: {
  payloadId?: string | null;
  userMessage?: string | null;
}): DomainCancelTarget | null => {
  const payload = params.payloadId ?? '';
  if (ORDER_PAYLOADS.has(payload)) return 'order';
  if (RESERVATION_PAYLOADS.has(payload)) return 'reservation';

  const msg = normalizeCommandText(params.userMessage ?? '');
  if (!msg) return null;

  const mentionsCancel = /\bcancel/.test(msg) || /\bborra/.test(msg);
  if (!mentionsCancel) return null;

  if (/\breserv/.test(msg)) return 'reservation';
  if (/\b(pedido|carrito)\b/.test(msg) || /\btodo\b/.test(msg)) return 'order';
  return null;
};
