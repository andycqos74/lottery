// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Determinism enforcement for Temporal workflow code.
 *
 * Technical spec T-6.1 / T-6.2 / T-6.3 are the load-bearing rules in this system:
 * a workflow that reads the clock, calls Math.random, or touches the database is
 * non-deterministic on replay. Worse, T-6.1 warns that using workflow-deterministic
 * randomness for the DRAW would make winning numbers a function of run identity —
 * predictable, and reproducible by a workflow reset. That is a gambling-integrity
 * failure, not a bug, so it is enforced by the build rather than by code review.
 *
 * The draw RNG lives in an activity (packages/activities/src/draw/rng.ts) and its
 * result is recorded in history, which gives replay the recorded numbers without
 * ever deriving them from workflow state.
 */
const workflowDeterminismRules = {
  'no-restricted-globals': [
    'error',
    { name: 'Date', message: 'T-6.2: use workflow.now() — wall-clock time breaks replay.' },
    { name: 'setTimeout', message: 'T-6.2: use workflow.sleep().' },
    { name: 'setInterval', message: 'T-6.2: use workflow.sleep() in a loop.' },
    { name: 'fetch', message: 'T-6.3: no I/O in workflow code. Use an activity.' },
    { name: 'crypto', message: 'T-6.1: no randomness in workflow code. RNG is an activity.' },
    { name: 'process', message: 'T-6.3: no environment access in workflow code.' },
  ],
  'no-restricted-properties': [
    'error',
    { object: 'Math', property: 'random', message: 'T-6.1 ⚠ CRITICAL: never generate randomness in workflow code. The draw RNG is an activity.' },
    { object: 'Date', property: 'now', message: 'T-6.2: use workflow.now().' },
    { object: 'crypto', property: 'randomUUID', message: 'T-6.3: use workflow.uuid4().' },
    { object: 'crypto', property: 'randomInt', message: 'T-6.1 ⚠ CRITICAL: RNG belongs in an activity.' },
  ],
  'no-restricted-imports': [
    'error',
    {
      paths: [
        { name: 'node:crypto', message: 'T-6.1/T-6.3: no crypto in workflow code.' },
        { name: 'crypto', message: 'T-6.1/T-6.3: no crypto in workflow code.' },
        { name: 'pg', message: 'T-1.2/T-6.3: workflow code reads no database.' },
        { name: 'kysely', message: 'T-1.2/T-6.3: workflow code reads no database.' },
        { name: 'uuid', message: 'T-6.3: use workflow.uuid4().' },
        { name: 'node:fs', message: 'T-6.3: no I/O in workflow code.' },
        { name: 'node:os', message: 'T-6.3: no host access in workflow code.' },
      ],
      patterns: [
        { group: ['@qosfc/db', '@qosfc/db/*'], message: 'T-1.2: workflow code reads no database. Fetch via an activity.' },
        { group: ['@qosfc/adapters-*'], message: 'T-6.3: adapters are I/O. Call them from activities.' },
        {
          group: ['@qosfc/activities', '@qosfc/activities/*'],
          importNames: ['default'],
          message: 'Import activity TYPES only (import type { ... }), never implementations — that would bundle I/O into the workflow sandbox.',
        },
      ],
    },
  ],
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // NFR-2 / T-2.1: money is bigint pence. Floating-point money is a defect.
      'no-loss-of-precision': 'error',
    },
  },
  {
    files: ['packages/workflows/src/**/*.ts'],
    rules: workflowDeterminismRules,
  },
  {
    // packages/domain is pure by contract — it is imported BY workflow code,
    // so it inherits the same determinism constraints.
    files: ['packages/domain/src/**/*.ts'],
    rules: workflowDeterminismRules,
  },
  {
    files: ['**/*.test.ts', 'tools/**/*.ts', 'deploy/**/*.ts'],
    rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off', 'no-restricted-imports': 'off' },
  },
);
