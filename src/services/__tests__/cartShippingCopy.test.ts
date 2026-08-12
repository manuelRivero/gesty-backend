import { describe, expect, it } from 'vitest';
import { formatCartShippingBullet } from '../cartShippingCopy';

const both = {
  deliveryEnabled: true,
  takeawayEnabled: true,
  fulfillmentType: null as 'DELIVERY' | 'TAKE_AWAY' | null,
};

describe('formatCartShippingBullet', () => {
  it('sin dirección: retiro gratis + delivery al checkout', () => {
    const line = formatCartShippingBullet({
      ...both,
      hasAddress: false,
      inCoverage: false,
      deliveryFee: null,
    });
    expect(line).toMatch(/retiro en el local, sin cargo/i);
    expect(line).toMatch(/según tu dirección/i);
    expect(line).toMatch(/calcula al finalizar/i);
    expect(line.startsWith('• *Envío:*')).toBe(true);
  });

  it('con dirección en cobertura: monto + retiro gratis', () => {
    const line = formatCartShippingBullet({
      ...both,
      hasAddress: true,
      inCoverage: true,
      deliveryFee: 800,
    });
    expect(line).toContain('$800');
    expect(line).toMatch(/a tu dirección/i);
    expect(line).toMatch(/retiro en el local es sin cargo/i);
  });

  it('dirección fuera de zona: retiro gratis y aclara cobertura', () => {
    const line = formatCartShippingBullet({
      ...both,
      hasAddress: true,
      inCoverage: false,
      deliveryFee: null,
    });
    expect(line).toMatch(/retiro en el local, sin cargo/i);
    expect(line).toMatch(/fuera de zona/i);
  });

  it('ya eligió TAKE_AWAY o DELIVERY: sin viñeta (va en la línea de modalidad)', () => {
    expect(
      formatCartShippingBullet({
        ...both,
        fulfillmentType: 'TAKE_AWAY',
        hasAddress: true,
        inCoverage: true,
        deliveryFee: 800,
      })
    ).toBe('');
    expect(
      formatCartShippingBullet({
        ...both,
        fulfillmentType: 'DELIVERY',
        hasAddress: true,
        inCoverage: true,
        deliveryFee: 800,
      })
    ).toBe('');
  });

  it('solo delivery, envío gratis a la dirección', () => {
    const line = formatCartShippingBullet({
      deliveryEnabled: true,
      takeawayEnabled: false,
      fulfillmentType: null,
      hasAddress: true,
      inCoverage: true,
      deliveryFee: 0,
    });
    expect(line).toBe('• *Envío:* a tu dirección, sin cargo.');
  });
});
