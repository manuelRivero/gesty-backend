import { defineConfig } from 'vitest/config';

/** Config solo para la suite diagnóstica de ataques conversacionales. */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['e2e/bot-attack.e2e.test.ts'],
    fileParallelism: false,
    testTimeout: 480_000,
    hookTimeout: 120_000,
    /** Mostrar console.log de observaciones aunque el test pase. */
    disableConsoleIntercept: true,
  },
});
