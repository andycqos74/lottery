import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'services/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Workflow and integration tests need real time; unit tests are fast.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
