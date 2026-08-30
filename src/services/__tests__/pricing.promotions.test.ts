import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { computeOrderPricing } from '../pricing.service';

const d = (value: number) => new Prisma.Decimal(value);

const item = (params: {
  quantity: number;
  unitPrice: number;
  listPrice?: number;
  discountAmount?: number;
}) => ({
  quantity: params.quantity,
  unit_price: d(params.unitPrice),
  list_price: params.listPrice != null ? d(params.listPrice) : null,
  discount_amount: params.discountAmount != null ? d(params.discountAmount) : null,
});

describe('computeOrderPricing — orden del cálculo con promociones (D5)', () => {
  const carrito10k = [item({ quantity: 2, unitPrice: 5000 })];

  it('itemsTotal se expone y no lo tiene que recalcular cada caller', () => {
    const pricing = computeOrderPricing([
      item({ quantity: 1, unitPrice: 850, listPrice: 1000, discountAmount: 150 }),
    ]);
    expect(pricing.subtotal).toBe(1000);
    expect(pricing.productDiscounts).toBe(150);
    expect(pricing.itemsTotal).toBe(850);
  });

  it('la promoción entra ANTES del ajuste porcentual por método de pago', () => {
    // $10.000 − $2.000 = $8.000 de base; recargo 10% sobre esa base = $800.
    const base = computeOrderPricing(carrito10k, { promotionDiscount: 2000 });
    expect(base.total).toBe(8000);

    const conRecargo = computeOrderPricing(carrito10k, {
      promotionDiscount: 2000,
      paymentAdjustment: base.total * 0.1,
    });
    expect(conRecargo.total).toBe(8800);
  });

  it('el orden importa: aplicar la promo después daría $9.000', () => {
    // Alternativa descartada en D5, acá como testigo del monto en juego.
    const sinPromo = computeOrderPricing(carrito10k);
    const recargoSobreTotalSinDescuento = sinPromo.total * 0.1;
    expect(sinPromo.total + recargoSobreTotalSinDescuento - 2000).toBe(9000);
  });

  it('un descuento por efectivo se calcula sobre la base ya descontada', () => {
    const base = computeOrderPricing(carrito10k, { promotionDiscount: 2000 });
    const conDescuento = computeOrderPricing(carrito10k, {
      promotionDiscount: 2000,
      paymentAdjustment: -base.total * 0.1,
    });
    expect(conDescuento.total).toBe(7200);
  });

  it('el envío se suma después de la promoción y antes del ajuste', () => {
    const pricing = computeOrderPricing(carrito10k, {
      promotionDiscount: 2000,
      deliveryFee: 1500,
    });
    expect(pricing.total).toBe(9500);
  });

  it('envío gratis se representa con deliveryFee 0, no como descuento', () => {
    const pricing = computeOrderPricing(carrito10k, { deliveryFee: 0 });
    expect(pricing.promotionDiscount).toBe(0);
    expect(pricing.total).toBe(10000);
  });

  it('la promoción nunca deja el total de ítems en negativo', () => {
    const pricing = computeOrderPricing(carrito10k, { promotionDiscount: 999999 });
    expect(pricing.promotionDiscount).toBe(10000);
    expect(pricing.total).toBe(0);
  });

  it('ignora un descuento negativo (llamador defectuoso)', () => {
    const pricing = computeOrderPricing(carrito10k, { promotionDiscount: -500 });
    expect(pricing.promotionDiscount).toBe(0);
    expect(pricing.total).toBe(10000);
  });

  it('convive con el descuento de catálogo sin doble conteo', () => {
    // $1.000 de lista con $150 de descuento de catálogo → $850 de itemsTotal.
    const pricing = computeOrderPricing(
      [item({ quantity: 1, unitPrice: 850, listPrice: 1000, discountAmount: 150 })],
      { promotionDiscount: 100 }
    );
    expect(pricing.itemsTotal).toBe(850);
    expect(pricing.total).toBe(750);
  });

  it('sin promoción el resultado es idéntico al comportamiento previo', () => {
    const pricing = computeOrderPricing(carrito10k, {
      deliveryFee: 1500,
      paymentAdjustment: 500,
    });
    expect(pricing.total).toBe(12000);
    expect(pricing.promotionDiscount).toBe(0);
  });
});
