import { describe, it, expect } from 'vitest';
import { resolveDomainCancelCommand } from '../domainCancelCommand.service';

describe('resolveDomainCancelCommand', () => {
  it('payloads de pedido', () => {
    expect(resolveDomainCancelCommand({ payloadId: 'CANCEL_ORDER' })).toBe('order');
    expect(resolveDomainCancelCommand({ payloadId: 'CANCEL_TARGET:draft' })).toBe('order');
    expect(resolveDomainCancelCommand({ payloadId: 'CANCEL_CHECKOUT' })).toBe('order');
  });

  it('payload de reserva', () => {
    expect(resolveDomainCancelCommand({ payloadId: 'RESERVATION_CANCEL' })).toBe(
      'reservation'
    );
  });

  it('tipables de título fijo', () => {
    expect(resolveDomainCancelCommand({ userMessage: 'Cancelar pedido' })).toBe('order');
    expect(resolveDomainCancelCommand({ userMessage: 'Cancelar reserva' })).toBe(
      'reservation'
    );
    expect(resolveDomainCancelCommand({ userMessage: 'cancelá la reserva' })).toBe(
      'reservation'
    );
  });

  it('reserva gana si el mensaje nombra reserva', () => {
    expect(
      resolveDomainCancelCommand({ userMessage: 'cancelar el pedido de la reserva' })
    ).toBe('reservation');
  });

  it('no intercepta prosa que no es comando', () => {
    expect(resolveDomainCancelCommand({ userMessage: 'Que platos sirven para la reserva ?' })).toBeNull();
    expect(resolveDomainCancelCommand({ userMessage: 'hola' })).toBeNull();
    expect(resolveDomainCancelCommand({ userMessage: 'sí, cancelar' })).toBeNull();
    expect(resolveDomainCancelCommand({ payloadId: 'CONFIRM_CANCEL_ORDER_FOR_RESERVATION' })).toBeNull();
  });
});
