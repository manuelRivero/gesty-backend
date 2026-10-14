/**
 * Auditoría de productos duplicados en Stripe (`sync-stripe-plans.ts`): cubre
 * `resolveAndPersistStripeProductAndPrice`, que reemplazó el `create`
 * incondicional por una búsqueda idempotente (ID persistido → metadata →
 * recién ahí crear). Mocks de Stripe y de Prisma — ninguna llamada real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    plan: {
      update: vi.fn(),
    },
  },
}));

import { prisma } from '../../../lib/prisma';
import { PlanSelectionError } from '../syncStripePlansSafety';
import {
  resolveAndPersistStripeProductAndPrice,
  type PlanForStripeSync,
  type StripeClientLike,
} from '../syncStripeProductPrice.service';

const mockedPlanUpdate = prisma.plan.update as unknown as ReturnType<typeof vi.fn>;

const EXPECTED = { currency: 'usd', unitAmountCents: 1500, interval: 'month' };

function fakePlan(overrides: Partial<PlanForStripeSync> = {}): PlanForStripeSync {
  return {
    id: 'plan-1',
    code: 'shopping_only',
    name: 'Shopping Only',
    description: 'Tienda web sin IA',
    stripe_product_id: null,
    ...overrides,
  };
}

function fakeStripe(overrides: Partial<StripeClientLike> = {}): StripeClientLike {
  return {
    products: {
      retrieve: vi.fn(),
      create: vi.fn(),
      list: vi.fn().mockResolvedValue({ data: [] }),
      ...overrides.products,
    },
    prices: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      create: vi
        .fn()
        .mockResolvedValue({ id: 'price_default', currency: 'usd', unit_amount: 1500, recurring: { interval: 'month' }, active: true }),
      ...overrides.prices,
    },
  } as StripeClientLike;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPlanUpdate.mockResolvedValue({});
});

describe('resolveAndPersistStripeProductAndPrice', () => {
  it('1. producto ya referenciado por la base de datos: se reutiliza (no busca ni crea)', async () => {
    const stripe = fakeStripe({
      products: {
        retrieve: vi.fn().mockResolvedValue({ id: 'prod_existing', metadata: {} }),
      } as any,
    });
    const plan = fakePlan({ stripe_product_id: 'prod_existing' });
    (stripe.prices.list as any).mockResolvedValue({
      data: [{ id: 'price_existing', currency: 'usd', unit_amount: 1500, recurring: { interval: 'month' }, active: true }],
    });

    const result = await resolveAndPersistStripeProductAndPrice(stripe, plan, EXPECTED);

    expect(stripe.products.retrieve).toHaveBeenCalledWith('prod_existing');
    expect(stripe.products.list).not.toHaveBeenCalled();
    expect(stripe.products.create).not.toHaveBeenCalled();
    expect(result.product.id).toBe('prod_existing');
    expect(result.price.id).toBe('price_existing');
    expect(mockedPlanUpdate).toHaveBeenCalledWith({
      where: { id: 'plan-1' },
      data: { stripe_product_id: 'prod_existing', stripe_price_id: 'price_existing' },
    });
  });

  it('2. producto encontrado por metadata (sin ID persistido): se reutiliza, no se crea otro', async () => {
    const stripe = fakeStripe({
      products: {
        list: vi.fn().mockResolvedValue({
          data: [
            { id: 'prod_other', metadata: { plan_code: 'basic', environment: 'test' } },
            { id: 'prod_match', metadata: { plan_code: 'shopping_only', environment: 'test' } },
          ],
        }),
        create: vi.fn(),
      } as any,
    });
    const plan = fakePlan({ stripe_product_id: null });

    const result = await resolveAndPersistStripeProductAndPrice(stripe, plan, EXPECTED);

    expect(stripe.products.create).not.toHaveBeenCalled();
    expect(result.product.id).toBe('prod_match');
  });

  it('3. dos productos candidatos por metadata: falla explícito sin crear nada', async () => {
    const stripe = fakeStripe({
      products: {
        list: vi.fn().mockResolvedValue({
          data: [
            { id: 'prod_a', metadata: { plan_code: 'shopping_only', environment: 'test' } },
            { id: 'prod_b', metadata: { plan_code: 'shopping_only', environment: 'test' } },
          ],
        }),
        create: vi.fn(),
      } as any,
    });
    const plan = fakePlan({ stripe_product_id: null });

    await expect(
      resolveAndPersistStripeProductAndPrice(stripe, plan, EXPECTED)
    ).rejects.toThrow(PlanSelectionError);

    expect(stripe.products.create).not.toHaveBeenCalled();
    expect(stripe.prices.create).not.toHaveBeenCalled();
    expect(mockedPlanUpdate).not.toHaveBeenCalled();
    try {
      await resolveAndPersistStripeProductAndPrice(stripe, plan, EXPECTED);
    } catch (err) {
      expect((err as Error).message).toContain('prod_a');
      expect((err as Error).message).toContain('prod_b');
    }
  });

  it('4. precio compatible existente (moneda/importe/periodicidad): se reutiliza, no se crea otro', async () => {
    const stripe = fakeStripe({
      products: { retrieve: vi.fn().mockResolvedValue({ id: 'prod_existing' }) } as any,
      prices: {
        list: vi.fn().mockResolvedValue({
          data: [{ id: 'price_match', currency: 'usd', unit_amount: 1500, recurring: { interval: 'month' }, active: true }],
        }),
        create: vi.fn(),
      } as any,
    });
    const plan = fakePlan({ stripe_product_id: 'prod_existing' });

    const result = await resolveAndPersistStripeProductAndPrice(stripe, plan, EXPECTED);

    expect(stripe.prices.create).not.toHaveBeenCalled();
    expect(result.price.id).toBe('price_match');
  });

  it('5. precio incompatible (otro importe): crea uno nuevo y preserva el anterior (no lo desactiva)', async () => {
    const createdPrice = { id: 'price_new', currency: 'usd', unit_amount: 1500, recurring: { interval: 'month' }, active: true };
    const priceCreate = vi.fn().mockResolvedValue(createdPrice);
    const stripe = fakeStripe({
      products: { retrieve: vi.fn().mockResolvedValue({ id: 'prod_existing' }) } as any,
      prices: {
        list: vi.fn().mockResolvedValue({
          data: [{ id: 'price_old', currency: 'usd', unit_amount: 999, recurring: { interval: 'month' }, active: true }],
        }),
        create: priceCreate,
      } as any,
    });
    const plan = fakePlan({ stripe_product_id: 'prod_existing' });

    const result = await resolveAndPersistStripeProductAndPrice(stripe, plan, EXPECTED);

    expect(priceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ product: 'prod_existing', unit_amount: 1500, currency: 'usd' })
    );
    // El price viejo nunca se toca (ni update ni deactivate): solo se llama a `create`.
    expect(result.price.id).toBe('price_new');
  });

  it('6. falla al persistir tras crear en Stripe: el siguiente intento recupera por metadata sin duplicar', async () => {
    const productCreate = vi.fn().mockResolvedValue({ id: 'prod_created', metadata: { plan_code: 'shopping_only', environment: 'test' } });
    const priceCreate = vi.fn().mockResolvedValue({ id: 'price_created', currency: 'usd', unit_amount: 1500, recurring: { interval: 'month' }, active: true });
    const productsList = vi.fn().mockResolvedValue({ data: [] });
    const stripe = fakeStripe({
      products: { list: productsList, create: productCreate } as any,
      prices: { list: vi.fn().mockResolvedValue({ data: [] }), create: priceCreate } as any,
    });
    const plan = fakePlan({ stripe_product_id: null });

    mockedPlanUpdate.mockRejectedValueOnce(new Error('db down'));
    await expect(resolveAndPersistStripeProductAndPrice(stripe, plan, EXPECTED)).rejects.toThrow('db down');
    expect(productCreate).toHaveBeenCalledTimes(1);

    // Reintento: la fila `plan` sigue sin IDs (la persistencia falló), pero
    // ahora Stripe ya tiene el producto con su metadata → se encuentra y
    // reutiliza en vez de crear otro.
    productsList.mockResolvedValue({
      data: [{ id: 'prod_created', metadata: { plan_code: 'shopping_only', environment: 'test' } }],
    });
    (stripe.prices.list as any).mockResolvedValue({
      data: [{ id: 'price_created', currency: 'usd', unit_amount: 1500, recurring: { interval: 'month' }, active: true }],
    });
    mockedPlanUpdate.mockResolvedValueOnce({});

    const result = await resolveAndPersistStripeProductAndPrice(stripe, plan, EXPECTED);

    expect(productCreate).toHaveBeenCalledTimes(1); // no se creó un segundo producto
    expect(priceCreate).toHaveBeenCalledTimes(1); // no se creó un segundo price
    expect(result.product.id).toBe('prod_created');
    expect(result.price.id).toBe('price_created');
  });

  it('7. segunda ejecución idéntica (ID ya persistido): no crea otro producto ni otro price', async () => {
    const stripe = fakeStripe({
      products: { retrieve: vi.fn().mockResolvedValue({ id: 'prod_existing' }), create: vi.fn() } as any,
      prices: {
        list: vi.fn().mockResolvedValue({
          data: [{ id: 'price_existing', currency: 'usd', unit_amount: 1500, recurring: { interval: 'month' }, active: true }],
        }),
        create: vi.fn(),
      } as any,
    });
    const plan = fakePlan({ stripe_product_id: 'prod_existing' });

    await resolveAndPersistStripeProductAndPrice(stripe, plan, EXPECTED);
    await resolveAndPersistStripeProductAndPrice(stripe, plan, EXPECTED);

    expect(stripe.products.create).not.toHaveBeenCalled();
    expect(stripe.prices.create).not.toHaveBeenCalled();
    expect(mockedPlanUpdate).toHaveBeenCalledTimes(2);
  });
});
