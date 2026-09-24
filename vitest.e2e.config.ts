import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['e2e/**/*.e2e.test.ts'],
    /**
     * Suites diagnósticas: no entran en `npm run test:e2e`.
     * `test:reservation-production`, `test:bot-attack`, `test:bot-attack-g2`
     * y `test:bot-attack-g3`.
     */
    exclude: [
      'e2e/reservation-production.e2e.test.ts',
      'e2e/bot-attack.e2e.test.ts',
      'e2e/bot-attack-g2.e2e.test.ts',
      'e2e/bot-attack-g3.e2e.test.ts',
    ],
    /** Un archivo E2E a la vez: comparten WHATSAPP_TEST_TO / conversación en BD. */
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 120_000,
  },
});
