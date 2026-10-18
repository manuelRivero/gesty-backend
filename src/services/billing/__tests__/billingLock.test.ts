/**
 * Tests de `withBillingLock` (billingLock.ts) con `pg` mockeado — NO contra
 * Postgres real. Esto prueba la lógica de adquisición/espera/liberación
 * (qué query se ejecuta, en qué orden, qué pasa si falla) con un cliente
 * falso, pero NO demuestra la garantía de exclusión mutua real entre dos
 * conexiones concurrentes a una base de datos real — eso requeriría un test
 * de integración contra Postgres (como `checkoutAttempt.postgres.integration.test.ts`
 * para `checkout_attempt`), que esta tarea no agrega. Queda señalado como
 * limitación explícita en la entrega, no se simula con mocks y se presenta
 * como "verificado en base de datos".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type FakeClient = {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
};

function fakeClient(): FakeClient {
  return { query: vi.fn(), release: vi.fn() };
}

let connectImpl: () => Promise<FakeClient>;

vi.mock('pg', () => {
  class FakePool {
    connect() {
      return connectImpl();
    }
    on() {
      // no-op: el código de producción solo usa esto para loguear errores
      // de conexiones idle, irrelevante acá.
    }
    end() {
      return Promise.resolve();
    }
  }
  return { Pool: FakePool };
});

vi.mock('../../../config/env', () => ({
  env: { DATABASE_URL: 'postgres://fake' },
}));

import {
  BillingLockTimeoutError,
  BillingLockUnavailableError,
  withBillingLock,
} from '../billingLock';

describe('withBillingLock', () => {
  beforeEach(() => {
    connectImpl = async () => fakeClient();
  });

  it('adquiere el lock, ejecuta `fn`, libera el lock y la conexión (sin destruirla)', async () => {
    const client = fakeClient();
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      throw new Error(`query inesperada: ${sql}`);
    });
    connectImpl = async () => client;

    const fn = vi.fn(async () => 'resultado');
    const result = await withBillingLock('ns', 'biz-1', fn);

    expect(result).toBe('resultado');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_try_advisory_lock'),
      expect.any(Array)
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_unlock'),
      expect.any(Array)
    );
    expect(client.release).toHaveBeenCalledWith(); // sin `true` — conexión sana
    expect(client.release).not.toHaveBeenCalledWith(true);
  });

  it('nunca invoca `fn` si el lock no se pudo adquirir dentro del tiempo máximo — responde 409 reintentable', async () => {
    const client = fakeClient();
    client.query.mockResolvedValue({ rows: [{ locked: false }] }); // siempre ocupado
    connectImpl = async () => client;

    const fn = vi.fn(async () => 'nunca debería llamarse');

    await expect(
      withBillingLock('ns', 'biz-1', fn, { maxWaitMs: 50 })
    ).rejects.toBeInstanceOf(BillingLockTimeoutError);
    await expect(
      withBillingLock('ns', 'biz-1', fn, { maxWaitMs: 50 })
    ).rejects.toMatchObject({ status: 409 });

    expect(fn).not.toHaveBeenCalled();
    // Nunca se adquirió: la conexión vuelve al pool tal cual, nunca se
    // intenta un `pg_advisory_unlock` que no correspondería.
    expect(client.release).toHaveBeenCalledWith();
    expect(client.release).not.toHaveBeenCalledWith(true);
  });

  it('si la adquisición en sí falla (la conexión se cae a mitad de intento): destruye la conexión y nunca llama a `fn`', async () => {
    const client = fakeClient();
    client.query.mockRejectedValueOnce(new Error('connection reset'));
    connectImpl = async () => client;

    const fn = vi.fn(async () => 'no debería llamarse');

    await expect(withBillingLock('ns', 'biz-1', fn)).rejects.toThrow('connection reset');
    expect(fn).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('si `fn` lanza: igual intenta liberar el lock (unlock) antes de propagar el error de `fn`', async () => {
    const client = fakeClient();
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      throw new Error(`query inesperada: ${sql}`);
    });
    connectImpl = async () => client;

    const boom = new Error('fn explotó');
    const fn = vi.fn(async () => {
      throw boom;
    });

    await expect(withBillingLock('ns', 'biz-1', fn)).rejects.toBe(boom);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_unlock'),
      expect.any(Array)
    );
    expect(client.release).toHaveBeenCalledWith();
  });

  it('si el `unlock` en sí falla (la query lanza, no que devuelva false): destruye la conexión en vez de devolverla al pool', async () => {
    const client = fakeClient();
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('pg_advisory_unlock')) throw new Error('conexión caída justo al liberar');
      throw new Error(`query inesperada: ${sql}`);
    });
    connectImpl = async () => client;

    const fn = vi.fn(async () => 'resultado ok');
    // La operación en sí tuvo éxito — el fallo de unlock no debe pisar eso.
    const result = await withBillingLock('ns', 'biz-1', fn);

    expect(result).toBe('resultado ok');
    expect(client.release).toHaveBeenCalledWith(true);
    expect(client.release).not.toHaveBeenCalledWith();
  });

  it('si `pool.connect()` falla (DB caída / pool agotado): 503, nunca invoca `fn`', async () => {
    connectImpl = async () => {
      throw new Error('ECONNREFUSED');
    };

    const fn = vi.fn(async () => 'no debería llamarse');

    await expect(withBillingLock('ns', 'biz-1', fn)).rejects.toBeInstanceOf(
      BillingLockUnavailableError
    );
    await expect(withBillingLock('ns', 'biz-1', fn)).rejects.toMatchObject({ status: 503 });
    expect(fn).not.toHaveBeenCalled();
  });

  it('serializa dos llamadas concurrentes para la MISMA clave: la segunda no ejecuta su `fn` hasta que la primera libera el lock — orden observable, no solo "se llamó al lock"', async () => {
    // Estado de lock compartido entre las dos "conexiones" — simula lo que
    // en Postgres real haría `pg_try_advisory_lock` para la misma clave
    // desde dos sesiones distintas.
    let held = false;
    const order: string[] = [];

    function clientFor(label: string): FakeClient {
      const client = fakeClient();
      client.query.mockImplementation(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) {
          if (held) return { rows: [{ locked: false }] };
          held = true;
          return { rows: [{ locked: true }] };
        }
        if (sql.includes('pg_advisory_unlock')) {
          held = false;
          return { rows: [{ unlocked: true }] };
        }
        throw new Error(`query inesperada (${label}): ${sql}`);
      });
      return client;
    }

    const clients = [clientFor('A'), clientFor('B')];
    let callIndex = 0;
    connectImpl = async () => clients[callIndex++];

    let releaseFirst: (() => void) | undefined;
    const firstFn = vi.fn(async () => {
      order.push('first-start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push('first-end');
      return 'first';
    });
    const secondFn = vi.fn(async () => {
      order.push('second-start');
      return 'second';
    });

    const firstCall = withBillingLock('ns', 'biz-1', firstFn, { maxWaitMs: 2000 });
    // Deja que la primera llamada adquiera el lock y entre a `fn` antes de
    // lanzar la segunda — evita una carrera de setup del propio test.
    await vi.waitFor(() => expect(firstFn).toHaveBeenCalled());

    const secondCall = withBillingLock('ns', 'biz-1', secondFn, { maxWaitMs: 2000 });

    // Mientras la primera sigue "corriendo" (no liberó su promesa interna),
    // la segunda todavía no debería haber podido entrar a su `fn`.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(secondFn).not.toHaveBeenCalled();

    releaseFirst?.();
    await firstCall;
    await secondCall;

    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('deriva claves de advisory lock distintas para negocios distintos (mismo namespace)', async () => {
    const client = fakeClient();
    const seenParams: unknown[] = [];
    client.query.mockImplementation(async (sql: string, params: unknown) => {
      if (sql.includes('pg_try_advisory_lock')) {
        seenParams.push(params);
        return { rows: [{ locked: true }] };
      }
      return { rows: [{ unlocked: true }] };
    });
    connectImpl = async () => client;

    await withBillingLock('ns', 'biz-1', async () => undefined);
    await withBillingLock('ns', 'biz-2', async () => undefined);

    expect(seenParams).toHaveLength(2);
    expect(seenParams[0]).not.toEqual(seenParams[1]);
  });
});
