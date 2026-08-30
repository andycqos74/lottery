import { readFileSync } from 'node:fs';
import pg from 'pg';
import { configurePgTypes } from './types.js';

export type Pool = pg.Pool;

export interface PoolOptions {
  readonly connectionString: string;
  /**
   * Path to a file holding the connection password (a mounted Docker secret in
   * production, `deploy/secrets/app_role_password` in local dev). Secrets are
   * files, never environment variables, so `connectionString` never carries a
   * password of its own — this is how one gets attached.
   */
  readonly passwordFile?: string | undefined;
  readonly max?: number;
  readonly applicationName?: string;
  /** Require TLS. Off only for a local dev container on a private docker network. */
  readonly ssl?: boolean;
}

export function createPool(options: PoolOptions): Pool {
  configurePgTypes();
  return new pg.Pool({
    connectionString: withPasswordFile(options.connectionString, options.passwordFile),
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'qosfc-lottery',
    ssl: options.ssl ? { rejectUnauthorized: true } : false,
    // Fail fast rather than queue forever: an activity that cannot reach the
    // database should return control to Temporal, which will retry it properly.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

/**
 * pg's own `password` pool option is silently discarded whenever
 * `connectionString` is also given — `pg-connection-string` parses the string
 * first and its (empty) password always wins the merge. So the password has to
 * go into the string itself, which is also why it must be percent-encoded here
 * rather than interpolated by hand: a raw secret can contain `/`, `@` or `%`.
 */
function withPasswordFile(connectionString: string, passwordFile: string | undefined): string {
  if (!passwordFile) return connectionString;
  const password = readFileSync(passwordFile, 'utf8').trim();
  const url = new URL(connectionString);
  url.password = password;
  return url.toString();
}

/**
 * Read the application's database connection settings from the environment,
 * the same way `connectionConfigFromEnv` does for Temporal.
 *
 * Every containerised process (`docker-compose.app.yml`) sets `APP_DB_URL` and
 * `APP_DB_PASSWORD_FILE` explicitly. The local-dev defaults below match the
 * `lottery_app` role and loopback port `bootstrap-app-db.sh` and
 * `docker-compose.core.yml` create, so `pnpm verify:stack` works from a repo-root
 * shell with no env vars set — mirroring Temporal's own `127.0.0.1:7233` default.
 */
export function appDbConnectionFromEnv(env: NodeJS.ProcessEnv = process.env): Pick<PoolOptions, 'connectionString' | 'passwordFile'> {
  const url = env['APP_DB_URL'];
  return {
    connectionString: url ?? 'postgres://lottery_app@127.0.0.1:5432/lottery_app',
    passwordFile: env['APP_DB_PASSWORD_FILE'] ?? (url ? undefined : 'deploy/secrets/app_role_password'),
  };
}

/**
 * Run a function inside one transaction.
 *
 * T-5.2: settle_draw writes the draw row, its ledger postings, and its prize rows
 * TOGETHER. Partial settlement is not a permitted state, so every multi-write
 * activity goes through here rather than issuing separate statements.
 */
export async function withTransaction<T>(pool: Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      /* the original error is the one worth reporting */
    });
    throw error;
  } finally {
    client.release();
  }
}
