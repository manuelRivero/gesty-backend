import { describe, it, expect } from 'vitest';
import {
  deriveConfirmarPagoOnlineCandidate,
  deriveDesbloquearPedidoCerradoCandidate,
} from '../catalogGoals.service';

describe('CONFIRMAR_PAGO_ONLINE (E.1)', () => {
  it('sin link → cerrado', () => {
    expect(
      deriveConfirmarPagoOnlineCandidate(
        { paymentLinkEmitted: false, paymentAccredited: false },
        {}
      )
    ).toBeNull();
  });

  it('con link unpaid → abierto', () => {
    expect(
      deriveConfirmarPagoOnlineCandidate(
        { paymentLinkEmitted: true, paymentAccredited: false },
        { surfaceCount: 0 }
      )?.type
    ).toBe('CONFIRMAR_PAGO_ONLINE');
  });

  it('paid → cerrado', () => {
    expect(
      deriveConfirmarPagoOnlineCandidate(
        { paymentLinkEmitted: true, paymentAccredited: true },
        { surfaceCount: 0 }
      )
    ).toBeNull();
  });
});

describe('DESBLOQUEAR_PEDIDO_CERRADO (E.2)', () => {
  it('sin pendiente → cerrado; con pending_closed_add_item → abierto', () => {
    expect(
      deriveDesbloquearPedidoCerradoCandidate({ pendingClosedAddItem: false }, {})
    ).toBeNull();
    expect(
      deriveDesbloquearPedidoCerradoCandidate(
        { pendingClosedAddItem: true },
        { surfaceCount: 0 }
      )?.type
    ).toBe('DESBLOQUEAR_PEDIDO_CERRADO');
  });
});

