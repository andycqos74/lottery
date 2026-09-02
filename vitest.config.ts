import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'services/**/*.test.ts', 'tools/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Workflow and integration tests need real time; unit tests are fast.
    testTimeout: 90_000,
    hookTimeout: 60_000,
    // The *.integration.test.ts files each reset the schema (DROP SCHEMA
    // public CASCADE; CREATE SCHEMA public;) against the single shared
    // TEST_APP_DB_URL database. Running test files in parallel lets one
    // file's reset drop objects another file is mid-migration on
    // ("referenced schema was concurrently dropped" / "relation ... does
    // not exist"). Keep file execution sequential so these can't race.
    fileParallelism: false,
  },
});
