import pg from 'pg';
import { configurePgTypes } from './types.js';

export type Pool = pg.Pool;

export interface PoolOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly applicationName?: string;
  /** Require TLS. Off only for a local dev container on a private docker network. */
  readonly ssl?: boolean;
}

export function createPool(options: PoolOptions): Pool {
  configurePgTypes();
  return new pg.Pool({
    connectionString: options.connectionString,
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
