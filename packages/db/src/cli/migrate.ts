#!/usr/bin/env tsx
/** `pnpm migrate` — apply pending migrations to APP_DB_URL. */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPool } from '../pool.js';
import { migrate } from '../migrate.js';

const url = process.env['APP_DB_MIGRATION_URL'] ?? process.env['APP_DB_URL'];
if (!url) {
  console.error('APP_DB_MIGRATION_URL (or APP_DB_URL) must be set.');
  console.error('Migrations run as the schema OWNER, not as lottery_app — see db/migrations/0007.');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = process.env['MIGRATIONS_DIR'] ?? resolve(here, '../../../../db/migrations');

const pool = createPool({
  connectionString: url,
  passwordFile: process.env['APP_DB_MIGRATION_PASSWORD_FILE'],
  applicationName: 'qosfc-migrate',
  max: 1,
});
try {
  console.log(`Migrating ${maskUrl(url)} from ${migrationsDir}`);
  const result = await migrate(pool, migrationsDir);
  console.log(
    result.applied.length > 0
      ? `Applied ${result.applied.length} migration(s); ${result.alreadyApplied.length} already present.`
      : `Nothing to do — ${result.alreadyApplied.length} migration(s) already applied.`,
  );
} finally {
  await pool.end();
}

function maskUrl(u: string): string {
  return u.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
}
