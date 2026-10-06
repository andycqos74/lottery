/**
 * Random numbers for lines nobody chose numbers for — GAP-13, resolved
 * (client decision, 2026-10-06).
 *
 * A member's prize draw number with no numbers on it a week after it was
 * issued (`member_number.created_at` — the final data load, for the legacy
 * register) gets four numbers from RANDOM.ORG, recorded as
 * `selection_source = 'randomly_allocated'`. The member is then told: by
 * email when there is an address on record, otherwise by a
 * `post_allocated_numbers` task for a person to post them.
 *
 * - Always RANDOM.ORG: refuses to run on any other configured source, the
 *   sandbox included, rather than quietly allocating from something else.
 * - Every line a member holds has different numbers (GAP-15): a draw that
 *   matches one of their other lines is thrown away and drawn again.
 * - Agent-collected numbers are left alone (GAP-19, option c): those players
 *   are entered on their agent's physical tickets and reached only through
 *   the agent. Agents' own numbers are skipped for the same reason.
 * - The allocation is a standing selection like any other (GAP-14): it is
 *   entered into upcoming draws exactly as a chosen one would be, whenever
 *   there is money or a mandate behind it.
 *
 * Run by `RandomAllocationSweepWorkflow` on the `selection-random-allocation`
 * Schedule. Returns counts only — numbers and names never enter workflow
 * history (TG-11).
 */
import { createHash } from 'node:crypto';
import { withTransaction, type Pool } from '@qosfc/db';
import { NUMBERS_PICK_K, NUMBERS_POOL_N } from '@qosfc/domain';
import { idempotencyKey, type Notifier, type RandomnessSource } from '@qosfc/ports';
import { writeAudit } from '../audit.js';
import { allocateUpcomingEntries } from '../draw/allocate-upcoming.js';
import { openHumanTask } from '../tasks/human-tasks.js';

/** The client's "allow one week" before allocating. */
export const RANDOM_ALLOCATION_GRACE_DAYS = 7;

export const POST_ALLOCATED_NUMBERS_TASK_KIND = 'post_allocated_numbers';

/** A RANDOM.ORG draw identical to one of the member's other lines is redrawn; this many identical draws in a row is not chance. */
const MAX_DRAWS_PER_LINE = 10;

export interface AllocateRandomSelectionsRequest {
  /** Lines allocated per run; the next scheduled run carries on from there. */
  readonly limit?: number;
}

export interface AllocateRandomSelectionsResult {
  readonly allocated: number;
  readonly emailed: number;
  readonly postTasks: number;
}

const sameNumbers = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i]);
const numbersLabel = (selection: readonly number[]) => selection.join(' · ');

export async function allocateRandomSelections(
  pool: Pool,
  randomness: RandomnessSource,
  notifier: Notifier,
  request: AllocateRandomSelectionsRequest,
): Promise<AllocateRandomSelectionsResult> {
  const { rows: candidates } = await pool.query<{ prize_draw_no: number; member_id: string }>(
    `SELECT mn.prize_draw_no, mn.member_id
       FROM member_number mn JOIN member m ON m.id = mn.member_id
      WHERE mn.row_type = 'member' AND m.status = 'active' AND m.member_type = 'player'
        AND mn.legacy_channel <> 'agent_collected'
        AND mn.created_at <= now() - make_interval(days => $1)
        AND NOT EXISTS (SELECT 1 FROM selection_standing ss WHERE ss.prize_draw_no = mn.prize_draw_no)
      ORDER BY mn.created_at, mn.prize_draw_no
      LIMIT $2`,
    [RANDOM_ALLOCATION_GRACE_DAYS, request.limit ?? 200],
  );

  if (candidates.length > 0 && randomness.kind !== 'random_org') {
    throw new Error(
      `GAP-13: random allocation always uses RANDOM.ORG, but RANDOMNESS_SOURCE is "${randomness.kind}". ` +
        `${candidates.length} line(s) are waiting for numbers; set RANDOMNESS_SOURCE=random_org.`,
    );
  }

  let allocated = 0;
  const membersAllocated = new Set<string>();
  for (const line of candidates) {
    if (await allocateLine(pool, randomness, line.prize_draw_no, line.member_id)) {
      allocated++;
      membersAllocated.add(line.member_id);
    }
  }

  // Tell the member before placing entries, so a failure placing them cannot
  // leave an allocation nobody was told about.
  const { emailed, postTasks } = await notifyAllocations(pool, notifier);

  for (const memberId of membersAllocated) {
    await allocateUpcomingEntries(pool, { memberId, actorLabel: 'system' });
  }

  return { allocated, emailed, postTasks };
}

/** False when the line got numbers some other way meanwhile (the member chose them). */
async function allocateLine(pool: Pool, randomness: RandomnessSource, prizeDrawNo: number, memberId: string): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_DRAWS_PER_LINE; attempt++) {
    // Outside the transaction: an HTTP call to RANDOM.ORG must not hold locks.
    const drawn = await randomness.generateWinningNumbers({
      drawId: `selection-allocation:${prizeDrawNo}`,
      poolN: NUMBERS_POOL_N,
      pickK: NUMBERS_PICK_K,
    });
    const selection = [...drawn.numbers].sort((a, b) => a - b);

    const outcome = await withTransaction(pool, async (client) => {
      // One member's lines are allocated one at a time, so two can never be given the same numbers.
      await client.query(`SELECT 1 FROM member WHERE id = $1 FOR UPDATE`, [memberId]);
      const { rows: already } = await client.query(`SELECT 1 FROM selection_standing WHERE prize_draw_no = $1 LIMIT 1`, [prizeDrawNo]);
      if (already.length > 0) return 'taken' as const;

      const { rows: others } = await client.query<{ selection: number[] }>(
        `SELECT ss.selection FROM selection_standing ss JOIN member_number mn ON mn.prize_draw_no = ss.prize_draw_no
          WHERE mn.member_id = $1 AND mn.row_type = 'member' AND ss.effective_to IS NULL`,
        [memberId],
      );
      if (others.some((o) => sameNumbers(o.selection, selection))) return 'clash' as const;

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO selection_standing (prize_draw_no, slot, selection, source)
         VALUES ($1, 1, $2, 'randomly_allocated') RETURNING id`,
        [prizeDrawNo, selection],
      );
      await writeAudit(client, {
        actorLabel: 'system',
        action: 'selection.randomly_allocated',
        entity: 'selection_standing',
        entityId: rows[0]!.id,
        after: { prizeDrawNo, memberId, selection, attempt, evidence: drawn.evidence, gapId: 'GAP-13' },
      });
      return 'allocated' as const;
    });

    if (outcome === 'allocated') return true;
    if (outcome === 'taken') return false;
  }
  throw new Error(
    `GAP-13: ${MAX_DRAWS_PER_LINE} RANDOM.ORG draws for prize draw no. ${prizeDrawNo} all matched another of the member's lines.`,
  );
}

async function notifyAllocations(pool: Pool, notifier: Notifier): Promise<{ emailed: number; postTasks: number }> {
  const { rows } = await pool.query<{
    id: string;
    prize_draw_no: number;
    selection: number[];
    member_id: string;
    has_email: boolean;
    forename: string | null;
    surname: string | null;
    has_address: boolean;
    has_telephone: boolean;
  }>(
    `SELECT ss.id, ss.prize_draw_no, ss.selection, m.id AS member_id, m.email IS NOT NULL AS has_email, m.forename, m.surname,
            (m.address_1 IS NOT NULL AND m.post_code IS NOT NULL) AS has_address, m.telephone IS NOT NULL AS has_telephone
       FROM selection_standing ss
       JOIN member_number mn ON mn.prize_draw_no = ss.prize_draw_no AND mn.row_type = 'member'
       JOIN member m ON m.id = mn.member_id
      WHERE ss.source = 'randomly_allocated' AND ss.allocation_notified_at IS NULL
      ORDER BY m.id, ss.prize_draw_no`,
  );

  // One message per member, listing every line allocated for them.
  const byMember = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) byMember.set(row.member_id, [...(byMember.get(row.member_id) ?? []), row]);

  let emailed = 0;
  let postTasks = 0;
  for (const [memberId, lines] of byMember) {
    const first = lines[0]!;
    const ids = lines.map((l) => l.id).sort();
    const ref = createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 32);
    const linesText = lines.map((l) => `${numbersLabel(l.selection)} (prize draw no. ${l.prize_draw_no})`).join('; ');

    let toldByEmail = false;
    if (first.has_email) {
      const outcome = await notifier.send({
        idempotencyKey: idempotencyKey(`numbers_allocated:${ref}`),
        memberRef: memberId,
        channel: 'email',
        templateId: 'numbers_allocated',
        mergeData: { forename: first.forename ?? '', lines: linesText },
      });
      toldByEmail = outcome.status === 'accepted';
    }

    if (toldByEmail) {
      emailed++;
    } else {
      const name = [first.forename, first.surname].filter(Boolean).join(' ') || 'a member with no name recorded';
      const howToReach = first.has_address
        ? 'Their postal address is on their member page.'
        : first.has_telephone
          ? 'There is no full postal address on record, but there is a telephone number on their member page.'
          : 'There is no postal address or telephone number on record either — check the source records.';
      await openHumanTask(pool, {
        kind: POST_ALLOCATED_NUMBERS_TASK_KIND,
        title: `Post ${name} their lottery numbers`,
        detail:
          `${first.has_email ? 'The email telling this member their numbers could not be sent' : 'This member has no email address'}. ` +
          `They did not choose numbers within a week, so these were picked at random from RANDOM.ORG: ${linesText}. ` +
          `${howToReach} Post them their numbers, and that they can contact the club for different ones.`,
        consequenceIfIgnored: 'The member is entered with numbers they do not know they have.',
        gapId: 'GAP-13',
        entityType: 'member',
        entityId: memberId,
        dedupeKey: `${POST_ALLOCATED_NUMBERS_TASK_KIND}:${ref}`,
      });
      postTasks++;
    }

    await pool.query(`UPDATE selection_standing SET allocation_notified_at = now() WHERE id = ANY($1::uuid[])`, [ids]);
  }
  return { emailed, postTasks };
}
