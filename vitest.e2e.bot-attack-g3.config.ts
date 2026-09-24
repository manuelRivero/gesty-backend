import { defineConfig } from 'vitest/config';

/** Config solo para la suite diagnóstica de ataques grado 3. */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['e2e/bot-attack-g3.e2e.test.ts'],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 120_000,
    /** Mostrar console.log de observaciones aunque el test pase. */
    disableConsoleIntercept: true,
  },
});
