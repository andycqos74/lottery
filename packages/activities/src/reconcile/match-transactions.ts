/**
 * Bank credit matching — functional spec §5.8.3, TG-04.
 *
 * TG-04 (auto-accept confidence threshold) is unresolved — `config_version
 * .recon_auto_threshold` is NULL — so every credit becomes a review task
 * today. This is the documented default behaviour (gap-register.md TG-04),
 * not a shortfall: nothing is auto-allocated until that threshold is set and
 * confirmed.
 *
 * A candidate is found by the prize draw number quoted in the payment
 * reference (FR-5.8.1) — that reference is the one thing a legacy standing
 * order mandate cannot omit, per `member_number.prize_draw_no`'s own comment.
 * FR-5.8.3: the evidence breakdown is what turns a sub-threshold match into an
 * identity question ("which member is this?") rather than an amount conflict.
 */
import type { PoolClient } from 'pg';

export type MatchOutcome = 'matched' | 'ambiguous' | 'unmatched';

interface CandidateRow {
  readonly prize_draw_no: number;
  readonly member_id: string | null;
}

async function findReferencedMembers(client: PoolClient, reference: string | null): Promise<CandidateRow[]> {
  if (!reference) return [];
  const digitGroups = reference.match(/\d+/g) ?? [];
  if (digitGroups.length === 0) return [];

  const numbers = [...new Set(digitGroups.map(Number))];
  const { rows } = await client.query<CandidateRow>(
    `SELECT prize_draw_no, member_id FROM member_number
      WHERE prize_draw_no = ANY($1::int[]) AND row_type = 'member'`,
    [numbers],
  );
  return rows;
}

async function amountMatchesActiveSubscription(client: PoolClient, memberId: string, amountPence: string): Promise<boolean> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM subscription
      WHERE member_id = $1 AND status = 'active' AND amount_pence = $2::bigint`,
    [memberId, amountPence],
  );
  return Number(rows[0]!.n) > 0;
}

async function activeRecoThreshold(client: PoolClient): Promise<number | null> {
  const { rows } = await client.query<{ recon_auto_threshold: string | null }>(
    `SELECT recon_auto_threshold::text FROM config_version WHERE is_active`,
  );
  const value = rows[0]?.recon_auto_threshold;
  return value === null || value === undefined ? null : Number(value);
}

/** Matches one bank_transaction, writes its match_candidate row(s), and opens a review task if needed. */
export async function matchBankTransaction(client: PoolClient, bankTransactionId: string): Promise<MatchOutcome> {
  const { rows: txnRows } = await client.query<{
    is_credit: boolean;
    amount_pence: string;
    extracted_reference: string | null;
    description: string | null;
  }>(`SELECT is_credit, amount_pence::text, extracted_reference, description FROM bank_transaction WHERE id = $1`, [bankTransactionId]);
  const txn = txnRows[0];
  if (!txn || !txn.is_credit) return 'unmatched';

  const candidates = await findReferencedMembers(client, txn.extracted_reference ?? txn.description);
  if (candidates.length === 0) {
    await client.query(`UPDATE bank_transaction SET match_status = 'unmatched' WHERE id = $1`, [bankTransactionId]);
    await openReviewTask(client, bankTransactionId, 'unmatched', 'No prize draw number could be read from the reference or description.');
    return 'unmatched';
  }

  const threshold = await activeRecoThreshold(client);
  let bestConfidence = 0;
  let soleAutoAcceptable: CandidateRow | undefined;

  for (const candidate of candidates) {
    let confidence = 0.5;
    const evidence: Record<string, unknown> = { referenceQuotedNumber: candidate.prize_draw_no };
    if (candidate.member_id) {
      const amountMatches = await amountMatchesActiveSubscription(client, candidate.member_id, txn.amount_pence);
      evidence['amountMatchesActiveSubscription'] = amountMatches;
      confidence = amountMatches ? 0.9 : 0.5;
    } else {
      evidence['note'] = 'prize_draw_no exists but is not linked to a member';
    }
    bestConfidence = Math.max(bestConfidence, confidence);

    await client.query(
      `INSERT INTO match_candidate (bank_transaction_id, prize_draw_no, confidence, evidence, decision)
       VALUES ($1,$2,$3,$4,'pending_review')
       ON CONFLICT (bank_transaction_id, prize_draw_no) DO UPDATE SET confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence`,
      [bankTransactionId, candidate.prize_draw_no, confidence, JSON.stringify(evidence)],
    );

    if (threshold !== null && confidence >= threshold && candidates.length === 1 && candidate.member_id) {
      soleAutoAcceptable = candidate;
    }
  }

  if (soleAutoAcceptable) {
    await client.query(
      `UPDATE match_candidate SET decision = 'auto_accepted' WHERE bank_transaction_id = $1 AND prize_draw_no = $2`,
      [bankTransactionId, soleAutoAcceptable.prize_draw_no],
    );
    await client.query(`UPDATE bank_transaction SET match_status = 'matched' WHERE id = $1`, [bankTransactionId]);
    await createAllocatedPayment(client, bankTransactionId, soleAutoAcceptable.member_id!, txn.amount_pence);
    return 'matched';
  }

  const status: MatchOutcome = 'ambiguous';
  await client.query(`UPDATE bank_transaction SET match_status = $2 WHERE id = $1`, [bankTransactionId, status]);
  await openReviewTask(
    client,
    bankTransactionId,
    status,
    candidates.length === 1
      ? `Prize draw number ${candidates[0]!.prize_draw_no} matched at confidence ${bestConfidence.toFixed(2)}, below the auto-accept threshold.`
      : `${candidates.length} candidate prize draw numbers found in this transaction's reference.`,
  );
  return status;
}

async function createAllocatedPayment(client: PoolClient, bankTransactionId: string, memberId: string, amountPence: string): Promise<void> {
  const { rows } = await client.query<{ channel: string; value_date: string }>(
    `SELECT channel, value_date::text FROM bank_transaction WHERE id = $1`,
    [bankTransactionId],
  );
  const txn = rows[0]!;
  await client.query(
    `INSERT INTO payment (member_id, channel, received_date, amount_pence, bank_transaction_id, allocation_confidence, allocation_method, status, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,1.0,'csv_reference_auto_accept','allocated',$6)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [memberId, txn.channel, txn.value_date, amountPence, bankTransactionId, `bank_txn:${bankTransactionId}`],
  );
}

async function openReviewTask(client: PoolClient, bankTransactionId: string, status: MatchOutcome, detail: string): Promise<void> {
  await client.query(
    `INSERT INTO human_task (kind, title, detail, consequence_if_ignored, entity_type, entity_id, dedupe_key)
     VALUES ('bank_transaction_review', $1, $2, $3, 'bank_transaction', $4, $5)
     ON CONFLICT (dedupe_key) WHERE status = 'open' DO NOTHING`,
    [
      status === 'unmatched' ? 'Unidentified bank credit' : 'Bank credit needs a member match confirmed',
      detail,
      'The payment stays unallocated and is not counted as income or entries for anyone until reviewed.',
      bankTransactionId,
      `bank_transaction_review:${bankTransactionId}`,
    ],
  );
}
