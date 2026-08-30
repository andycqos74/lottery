/**
 * The draw RNG activity.
 *
 * ⚠ T-6.1 — the single most important rule in the technical specification.
 *
 * The winning numbers are generated HERE, in an activity, and never in workflow
 * code. Temporal's workflow-deterministic random source is stable across replay,
 * which sounds like exactly what an auditable draw wants and is in fact the
 * opposite: it would make the numbers a deterministic function of workflow run
 * identity, so anyone able to observe or predict run identity could predict the
 * draw, and a workflow reset would reproduce the same numbers.
 *
 * Generating them in an activity records the RESULT in history. Replay therefore
 * reproduces the RECORDED draw — precisely the audit property NFR-1 requires —
 * without the numbers ever having been derived from workflow state.
 */
import { withTransaction, type Pool } from '@qosfc/db';
import type { RandomnessSource } from '@qosfc/ports';
import type { Selection } from '@qosfc/domain';
import { writeAudit } from '../audit.js';

export interface GenerateNumbersRequest {
  readonly drawId: string;
  readonly poolN: number;
  readonly pickK: number;
}

export interface GenerateNumbersResult {
  readonly numbers: Selection;
  readonly source: string;
  readonly seed: string;
}

/**
 * Idempotent by construction: if the draw row already carries winning numbers,
 * they are returned unchanged.
 *
 * This matters more here than anywhere else in the system. T-12.4 requires the
 * specific test "worker killed between generate_winning_numbers and settle_draw":
 * on retry, this activity must return the numbers already drawn, not draw a
 * second set. A draw that quietly re-rolled after a crash would be undetectable
 * from the outside and indefensible.
 */
export async function generateWinningNumbers(
  pool: Pool,
  randomness: RandomnessSource,
  request: GenerateNumbersRequest,
): Promise<GenerateNumbersResult> {
  return withTransaction(pool, async (client) => {
    // Lock the row: two concurrent attempts must not both draw.
    const existing = await client.query<{
      winning_numbers: number[] | null;
      rng_source: string | null;
      rng_seed: string | null;
      status: string;
    }>(`SELECT winning_numbers, rng_source, rng_seed, status FROM draw WHERE id = $1 FOR UPDATE`, [
      request.drawId,
    ]);

    const row = existing.rows[0];
    if (!row) throw new Error(`Draw ${request.drawId} does not exist.`);

    if (row.winning_numbers) {
      return {
        numbers: row.winning_numbers as unknown as Selection,
        source: row.rng_source ?? 'unknown',
        seed: row.rng_seed ?? '',
      };
    }

    if (row.status !== 'closed') {
      throw new Error(
        `Draw ${request.drawId} is '${row.status}'. Numbers may only be generated once entries are frozen (FR-5.3.3).`,
      );
    }

    const result = await randomness.generateWinningNumbers(request);

    await client.query(
      `UPDATE draw
          SET winning_numbers = $2, rng_source = $3, rng_seed = $4, rng_evidence = $5,
              drawn_at = now(), status = 'drawn'
        WHERE id = $1`,
      [
        request.drawId,
        result.numbers,
        result.evidence.source,
        result.evidence.seed,
        JSON.stringify(result.evidence.evidence),
      ],
    );

    await writeAudit(client, {
      actorLabel: 'system',
      action: 'draw.numbers_generated',
      entity: 'draw',
      entityId: request.drawId,
      // The numbers and their provenance, so the audit log alone answers
      // "who drew what, when, and how" without trusting the draw row.
      after: {
        numbers: result.numbers,
        source: result.evidence.source,
        seed: result.evidence.seed,
        evidence: result.evidence.evidence,
      },
    });

    return { numbers: result.numbers, source: result.evidence.source, seed: result.evidence.seed };
  });
}
