/**
 * Migration runner.
 *
 * Deliberately small and boring: each .sql file runs once, in filename order,
 * inside one transaction, and its hash is recorded. Re-running an already-applied
 * file whose content has changed is an ERROR rather than a silent skip — on a
 * system holding gambling money, a migration that means something different from
 * what was applied to production is worth stopping for.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from './pool.js';

export interface MigrationResult {
  readonly applied: string[];
  readonly alreadyApplied: string[];
}

const CREATE_TRACKING_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migration (
    filename    text PRIMARY KEY,
    sha256      text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )`;

export async function migrate(pool: Pool, migrationsDir: string, log = console.log): Promise<MigrationResult> {
  await pool.query(CREATE_TRACKING_TABLE);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ filename: string; sha256: string }>(
    'SELECT filename, sha256 FROM schema_migration',
  );
  const applied = new Map(rows.map((r) => [r.filename, r.sha256]));

  const newlyApplied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const filename of files) {
    const sql = await readFile(join(migrationsDir, filename), 'utf8');
    const sha256 = createHash('sha256').update(sql).digest('hex');
    const previous = applied.get(filename);

    if (previous !== undefined) {
      if (previous !== sha256) {
        throw new Error(
          `Migration ${filename} has changed since it was applied (recorded ${previous.slice(0, 12)}, ` +
            `now ${sha256.slice(0, 12)}). Applied migrations are immutable — add a new migration instead.`,
        );
      }
      alreadyApplied.push(filename);
      continue;
    }

    log(`  applying ${filename}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migration (filename, sha256) VALUES ($1, $2)', [filename, sha256]);
      await client.query('COMMIT');
      newlyApplied.push(filename);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Migration ${filename} failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    } finally {
      client.release();
    }
  }

  return { applied: newlyApplied, alreadyApplied };
}
