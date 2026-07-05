import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['e2e/**/*.e2e.test.ts'],
    /** Un archivo E2E a la vez: comparten WHATSAPP_TEST_TO / conversación en BD. */
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 120_000,
  },
});
