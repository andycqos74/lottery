/**
 * Bank reconciliation, verified against a real PostgreSQL instance — the CSV
 * ingestion path (GAP-33) and the matching engine (TG-04) together, the same
 * way packages/db/src/security.integration.test.ts proves database behaviour
 * rather than mocking it away.
 *
 * Set TEST_APP_DB_URL to run. Without it the suite skips rather than silently
 * passing, so a green CI run with no database does not look like proof.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPool, migrate, type Pool } from '@qosfc/db';
import type { BankCredit, BankFeed, StatementSummary } from '@qosfc/ports';
import { ingestNewStatements } from './ingest-statement.js';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

class FakeBankFeed implements BankFeed {
  readonly providerName = 'fake:test';
  readonly source = 'csv' as const;
  constructor(private readonly statements: readonly { summary: StatementSummary; credits: readonly BankCredit[] }[]) {}

  async listStatements(): Promise<readonly StatementSummary[]> {
    return this.statements.map((s) => s.summary);
  }

  async extractCredits(request: { statementNumber: number }): Promise<{ credits: readonly BankCredit[] }> {
    const found = this.statements.find((s) => s.summary.statementNumber === request.statementNumber);
    if (!found) throw new Error('no such statement');
    return { credits: found.credits };
  }
}

describeDb('bank reconciliation (GAP-33 / TG-04)', () => {
  let pool: Pool;
  let memberId: string;

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-recon-test', max: 4 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const here = dirname(fileURLToPath(import.meta.url));
    await migrate(pool, resolve(here, '../../../../db/migrations'), () => {});

    await pool.query(`INSERT INTO config_version (note) VALUES ('test fixture')`);

    memberId = (
      await pool.query(`INSERT INTO member (forename, surname) VALUES ('Test','Member') RETURNING id`)
    ).rows[0].id;
    await pool.query(`INSERT INTO member_number (prize_draw_no, member_id, row_type) VALUES (4521, $1, 'member')`, [memberId]);
    await pool.query(
      `INSERT INTO subscription (member_id, amount_pence, frequency, status) VALUES ($1, 500, 'weekly', 'active')`,
      [memberId],
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('sends every credit to review when the auto-accept threshold is unset (TG-04 default)', async () => {
    const feed = new FakeBankFeed([
      {
        summary: { statementNumber: 1, periodStart: '2026-08-01', periodEnd: '2026-08-07', openingBalancePence: '0', closingBalancePence: '500', source: 'csv', sourceRef: 'test' },
        credits: [
          {
            externalId: 'c1',
            valueDate: '2026-08-03',
            description: 'STANDING ORDER REF 4521',
            typeRaw: 'Standing Order',
            amountPence: '500',
            isCredit: true,
            extractedReference: '4521',
          },
        ],
      },
    ]);

    const [result] = await ingestNewStatements(pool, feed, { actorLabel: 'test' });
    expect(result).toMatchObject({ alreadyIngested: false, transactionCount: 1, matched: 0, ambiguous: 1, unmatched: 0 });

    const { rows: tasks } = await pool.query(`SELECT kind FROM human_task WHERE kind = 'bank_transaction_review'`);
    expect(tasks).toHaveLength(1);
  });

  it('opens an unmatched review task when no prize draw number can be read from the reference', async () => {
    const feed = new FakeBankFeed([
      {
        summary: { statementNumber: 2, periodStart: '2026-08-08', periodEnd: '2026-08-14', openingBalancePence: '500', closingBalancePence: '1000', source: 'csv', sourceRef: 'test' },
        credits: [
          { externalId: 'c2', valueDate: '2026-08-10', description: 'unclear payment', typeRaw: 'Transfer', amountPence: '500', isCredit: true },
        ],
      },
    ]);

    const [result] = await ingestNewStatements(pool, feed, { actorLabel: 'test' });
    expect(result).toMatchObject({ matched: 0, ambiguous: 0, unmatched: 1 });
  });

  it('rejects a statement whose opening balance breaks continuity with the previous one (FR-5.8.2)', async () => {
    const feed = new FakeBankFeed([
      {
        summary: { statementNumber: 3, periodStart: '2026-08-15', periodEnd: '2026-08-21', openingBalancePence: '999999', closingBalancePence: '999999', source: 'csv', sourceRef: 'test' },
        credits: [],
      },
    ]);

    await expect(ingestNewStatements(pool, feed, { actorLabel: 'test' })).rejects.toThrow(/continuity must hold/);

    const { rows } = await pool.query(`SELECT id FROM bank_statement WHERE statement_number = 3`);
    expect(rows).toHaveLength(0);
  });

  it('is idempotent — re-ingesting a known statement number is a no-op', async () => {
    const feed = new FakeBankFeed([
      {
        summary: { statementNumber: 1, periodStart: '2026-08-01', periodEnd: '2026-08-07', openingBalancePence: '0', closingBalancePence: '500', source: 'csv', sourceRef: 'test' },
        credits: [],
      },
    ]);
    const [result] = await ingestNewStatements(pool, feed, { actorLabel: 'test' });
    expect(result).toMatchObject({ alreadyIngested: true });
  });
});
