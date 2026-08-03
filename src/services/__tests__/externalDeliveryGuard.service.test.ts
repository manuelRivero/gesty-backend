import { describe, expect, it } from 'vitest';
import { isOwnDeliveryBlocked } from '../externalDeliveryGuard.service';

describe('isOwnDeliveryBlocked', () => {
  it('bloquea solo rol DELIVERY con external ON', () => {
    expect(
      isOwnDeliveryBlocked({ role: 'DELIVERY', externalDeliveryEnabled: true })
    ).toBe(true);
  });

  it('no bloquea DELIVERY con external OFF', () => {
    expect(
      isOwnDeliveryBlocked({ role: 'DELIVERY', externalDeliveryEnabled: false })
    ).toBe(false);
  });

  it('no bloquea OWNER/ADMIN aunque external esté ON', () => {
    expect(
      isOwnDeliveryBlocked({ role: 'OWNER', externalDeliveryEnabled: true })
    ).toBe(false);
    expect(
      isOwnDeliveryBlocked({ role: 'ADMIN', externalDeliveryEnabled: true })
    ).toBe(false);
  });

  it('no bloquea sin rol', () => {
    expect(
      isOwnDeliveryBlocked({ role: undefined, externalDeliveryEnabled: true })
    ).toBe(false);
  });
});
