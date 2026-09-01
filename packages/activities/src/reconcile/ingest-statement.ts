/**
 * Bank statement ingestion — GAP-33, resolved: CSV upload (Open Banking left
 * for future consideration, OCR not pursued), functional spec §5.8.1/§5.8.2,
 * technical spec §4.4.
 *
 * Written against the `BankFeed` port, not any one adapter — CSV today, but
 * the same ingestion logic runs unchanged if Open Banking is adopted later
 * (the whole point of the port, per its own header comment).
 *
 * FR-5.8.2: continuity is verified BEFORE extraction — this statement's
 * opening balance must equal the previous one's closing balance. A break
 * halts the whole batch rather than producing a partial reconciliation that
 * looks complete, so nothing is written for a statement that fails it.
 *
 * Idempotent on `statement_number` (UNIQUE): a statement already in
 * `bank_statement` is skipped rather than re-ingested, exactly like
 * `settleDraw` treats a retried activity.
 */
import { randomUUID } from 'node:crypto';
import { withTransaction, type Pool } from '@qosfc/db';
import type { PoolClient } from 'pg';
import type { BankCredit, BankFeed } from '@qosfc/ports';
import { writeAudit } from '../audit.js';
import { matchBankTransaction } from './match-transactions.js';

export interface IngestNewStatementsRequest {
  readonly since?: number;
  readonly actorId?: string;
  readonly actorLabel: string;
}

export interface IngestedStatement {
  readonly statementId: string;
  readonly statementNumber: number;
  readonly alreadyIngested: boolean;
  readonly transactionCount: number;
  readonly matched: number;
  readonly ambiguous: number;
  readonly unmatched: number;
}

const TYPE_TO_CHANNEL: Record<string, string> = {
  'standing order': 'so_fps',
  transfer: 'so_fps',
  giro: 'giro',
  branch: 'branch_cash',
};

function channelFor(typeRaw: string): string {
  return TYPE_TO_CHANNEL[typeRaw.trim().toLowerCase()] ?? 'so_fps';
}

export async function ingestNewStatements(
  pool: Pool,
  bankFeed: BankFeed,
  request: IngestNewStatementsRequest,
): Promise<readonly IngestedStatement[]> {
  const statements = await bankFeed.listStatements(request.since !== undefined ? { since: request.since } : {});
  const results: IngestedStatement[] = [];
  for (const summary of statements) {
    const outcome = await withTransaction(pool, async (client) => {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM bank_statement WHERE statement_number = $1`,
        [summary.statementNumber],
      );
      if (existing.rows[0]) {
        const counts = await matchStatusCounts(client, existing.rows[0].id);
        return { statementId: existing.rows[0].id, statementNumber: summary.statementNumber, alreadyIngested: true, ...counts };
      }

      // A source with no balance at all (the real "TransactionHistory" export,
      // B-10) cannot be continuity-checked — that is a documented reduction in
      // what is verified, not a failure, per Andy Cowan's direction. Dedup then
      // rests entirely on `external_id` (below), not on this chain.
      const hasBalances = summary.openingBalancePence !== undefined && summary.closingBalancePence !== undefined;
      let chainVerified = false;
      if (hasBalances) {
        const previous = await client.query<{ closing_balance_pence: string }>(
          `SELECT closing_balance_pence::text FROM bank_statement
            WHERE statement_number < $1 AND closing_balance_pence IS NOT NULL
            ORDER BY statement_number DESC LIMIT 1`,
          [summary.statementNumber],
        );
        chainVerified = previous.rows.length === 0 || previous.rows[0]!.closing_balance_pence === summary.openingBalancePence;
        if (!chainVerified) {
          throw new Error(
            `Statement ${summary.statementNumber}'s opening balance (${summary.openingBalancePence}p) does not ` +
              `match the previous statement's closing balance (${previous.rows[0]!.closing_balance_pence}p). ` +
              `FR-5.8.2: continuity must hold before extraction — nothing has been ingested.`,
          );
        }
      }

      const { credits } = await bankFeed.extractCredits({ statementNumber: summary.statementNumber });

      const statementId = randomUUID();
      await client.query(
        `INSERT INTO bank_statement
           (id, statement_number, period_start, period_end, opening_balance_pence, closing_balance_pence,
            source, chain_verified, source_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          statementId,
          summary.statementNumber,
          summary.periodStart,
          summary.periodEnd,
          summary.openingBalancePence ?? null,
          summary.closingBalancePence ?? null,
          summary.source,
          chainVerified,
          summary.sourceRef,
        ],
      );

      // Only newly-inserted transactions get matched — a row already ingested
      // by an earlier, overlapping upload keeps whatever match/task it already
      // has rather than being re-evaluated (and re-queued) a second time.
      const transactionIds: string[] = [];
      for (const row of credits) {
        const { id, isNew } = await insertTransaction(client, statementId, row);
        if (isNew) transactionIds.push(id);
      }

      await writeAudit(client, {
        ...(request.actorId ? { actorId: request.actorId } : {}),
        actorLabel: request.actorLabel,
        action: 'bank_statement.ingested',
        entity: 'bank_statement',
        entityId: statementId,
        after: { statementNumber: summary.statementNumber, transactionCount: credits.length, source: summary.source },
      });

      let matched = 0;
      let ambiguous = 0;
      let unmatched = 0;
      for (const transactionId of transactionIds) {
        const status = await matchBankTransaction(client, transactionId);
        if (status === 'matched') matched++;
        else if (status === 'ambiguous') ambiguous++;
        else if (status === 'unmatched') unmatched++;
      }

      return {
        statementId,
        statementNumber: summary.statementNumber,
        alreadyIngested: false,
        transactionCount: credits.length,
        matched,
        ambiguous,
        unmatched,
      };
    });
    results.push(outcome);
  }
  return results;
}

async function insertTransaction(
  client: PoolClient,
  statementId: string,
  row: BankCredit,
): Promise<{ id: string; isNew: boolean }> {
  const id = randomUUID();
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO bank_transaction
       (id, statement_id, value_date, description, type_raw, channel, amount_pence, is_credit,
        extracted_reference, extracted_name, ocr_confidence, external_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      id,
      statementId,
      row.valueDate,
      row.description,
      row.typeRaw,
      row.isCredit ? channelFor(row.typeRaw) : null,
      row.amountPence,
      row.isCredit,
      row.extractedReference ?? null,
      row.extractedName ?? null,
      row.confidence ?? null,
      row.externalId,
    ],
  );
  if (rows[0]) return { id: rows[0].id, isNew: true };

  const existing = await client.query<{ id: string }>(`SELECT id FROM bank_transaction WHERE external_id = $1`, [row.externalId]);
  return { id: existing.rows[0]!.id, isNew: false };
}

async function matchStatusCounts(
  client: PoolClient,
  statementId: string,
): Promise<{ transactionCount: number; matched: number; ambiguous: number; unmatched: number }> {
  const { rows } = await client.query<{ match_status: string; n: string }>(
    `SELECT match_status, count(*)::text AS n FROM bank_transaction WHERE statement_id = $1 GROUP BY match_status`,
    [statementId],
  );
  const counts = { transactionCount: 0, matched: 0, ambiguous: 0, unmatched: 0 };
  for (const row of rows) {
    const n = Number(row.n);
    counts.transactionCount += n;
    if (row.match_status === 'matched') counts.matched += n;
    else if (row.match_status === 'ambiguous') counts.ambiguous += n;
    else if (row.match_status === 'unmatched') counts.unmatched += n;
  }
  return counts;
}
