import { defineConfig } from 'vitest/config';

/** Config solo para la suite diagnóstica de reservas de producción. */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['e2e/reservation-production.e2e.test.ts'],
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 120_000,
    /** Mostrar console.log de observaciones aunque el test pase. */
    disableConsoleIntercept: true,
  },
});
