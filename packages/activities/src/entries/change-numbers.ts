/**
 * Changing the numbers on a line — from the member portal, or by admin staff
 * on a member's behalf.
 *
 * A line (db/migrations/0018) is `(prize_draw_no, slot)`: payments, Direct
 * Debits and entries all hang off the line, not off its numbers, so changing
 * the numbers keeps every paid week and mandate exactly where it was. The
 * current `selection_standing` row is closed (`effective_to`) and a new one
 * opened on the same slot — never edited — so what a line held on any past
 * date stays answerable.
 *
 * - GAP-15: a player never holds two lines with the same numbers. Agents are
 *   exempt, as everywhere: their tickets belong to different players.
 * - Entries already placed in draws still taking entries take the new numbers
 *   (`allocateUpcomingEntries`). A draw whose entries have closed keeps the
 *   numbers it was entered with — the cutoff is the point after which
 *   entries do not change (GitHub #4).
 * - A randomly allocated line (GAP-13) changed by the member becomes
 *   `member_chosen`.
 */
import { withTransaction, type Pool } from '@qosfc/db';
import { parseSelection } from '@qosfc/domain';
import { writeAudit } from '../audit.js';
import { allocateUpcomingEntries } from '../draw/allocate-upcoming.js';

export interface ChangeLineNumbersRequest {
  readonly memberId: string;
  readonly prizeDrawNo: number;
  readonly slot: number;
  readonly selection: readonly number[];
  readonly actorLabel: string;
  readonly actorId?: string;
}

export type ChangeLineNumbersResult =
  | {
      readonly kind: 'changed';
      readonly selection: readonly number[];
      /** Entries in draws still taking entries that now carry the new numbers. */
      readonly entriesUpdated: number;
      /** Entries in draws already closed to entries, still on the old numbers. */
      readonly closedDrawsKeepingOldNumbers: number;
    }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'rejected'; readonly reason: string };

const sameNumbers = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i]);

export async function changeLineNumbers(pool: Pool, request: ChangeLineNumbersRequest): Promise<ChangeLineNumbersResult> {
  const parsed = parseSelection([...new Set(request.selection)]);
  if (!parsed.ok) return { kind: 'rejected', reason: 'Pick four different numbers from 1 to 20.' };
  const selection = [...parsed.selection].sort((a, b) => a - b);

  const outcome = await withTransaction(pool, async (client) => {
    const { rows: memberRows } = await client.query<{ member_type: string }>(
      `SELECT member_type FROM member WHERE id = $1 FOR UPDATE`,
      [request.memberId],
    );
    const member = memberRows[0];
    if (!member) return { kind: 'rejected', reason: 'Member not found.' } as const;

    const { rows: current } = await client.query<{ id: string; selection: number[]; source: string }>(
      `SELECT ss.id, ss.selection, ss.source::text
         FROM selection_standing ss JOIN member_number mn ON mn.prize_draw_no = ss.prize_draw_no
        WHERE ss.prize_draw_no = $1 AND ss.slot = $2 AND ss.effective_to IS NULL
          AND mn.member_id = $3 AND mn.row_type = 'member'
        FOR UPDATE OF ss`,
      [request.prizeDrawNo, request.slot, request.memberId],
    );
    const line = current[0];
    if (!line) return { kind: 'rejected', reason: 'That set of numbers was not found on this account.' } as const;
    if (sameNumbers(line.selection, selection)) return { kind: 'unchanged' } as const;

    if (member.member_type !== 'agent') {
      const { rows: clash } = await client.query(
        `SELECT 1 FROM selection_standing ss JOIN member_number mn ON mn.prize_draw_no = ss.prize_draw_no
          WHERE mn.member_id = $1 AND mn.row_type = 'member' AND ss.effective_to IS NULL
            AND ss.id <> $2 AND ss.selection = $3::int[]
          LIMIT 1`,
        [request.memberId, line.id, selection],
      );
      if (clash.length > 0) return { kind: 'rejected', reason: 'You already have those numbers on another line.' } as const;
    }

    await client.query(`UPDATE selection_standing SET effective_to = CURRENT_DATE WHERE id = $1`, [line.id]);
    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO selection_standing (prize_draw_no, slot, selection, source, effective_from)
       VALUES ($1, $2, $3, 'member_chosen', CURRENT_DATE) RETURNING id`,
      [request.prizeDrawNo, request.slot, selection],
    );

    const { rows: closedRows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM entry e JOIN draw d ON d.id = e.draw_id
        WHERE e.member_id = $1 AND e.prize_draw_no = $2 AND e.selection_slot = $3 AND e.voided_at IS NULL
          AND d.status IN ('open', 'closed') AND (d.status = 'closed' OR d.entries_close_at <= now())`,
      [request.memberId, request.prizeDrawNo, request.slot],
    );

    await writeAudit(client, {
      ...(request.actorId ? { actorId: request.actorId } : {}),
      actorLabel: request.actorLabel,
      action: 'selection.changed',
      entity: 'selection_standing',
      entityId: inserted[0]!.id,
      before: { selectionStandingId: line.id, selection: line.selection, source: line.source },
      after: { prizeDrawNo: request.prizeDrawNo, slot: request.slot, selection, memberId: request.memberId },
    });
    return { kind: 'changed', closed: Number(closedRows[0]!.n) } as const;
  });

  if (outcome.kind !== 'changed') return outcome;

  const placed = await allocateUpcomingEntries(pool, {
    memberId: request.memberId,
    actorLabel: request.actorLabel,
    ...(request.actorId ? { actorId: request.actorId } : {}),
  });
  return {
    kind: 'changed',
    selection,
    entriesUpdated: placed.selectionsUpdated,
    closedDrawsKeepingOldNumbers: outcome.closed,
  };
}

/** What to tell whoever changed the numbers. */
export function describeNumbersChange(result: Extract<ChangeLineNumbersResult, { kind: 'changed' }>): string {
  const numbers = result.selection.join(' · ');
  const updated =
    result.entriesUpdated > 0
      ? ` They replace the old numbers in ${result.entriesUpdated} upcoming draw${result.entriesUpdated === 1 ? '' : 's'} already entered.`
      : '';
  const kept =
    result.closedDrawsKeepingOldNumbers > 0
      ? ` ${result.closedDrawsKeepingOldNumbers === 1 ? 'One draw has' : `${result.closedDrawsKeepingOldNumbers} draws have`} already closed to entries and will be drawn with the old numbers.`
      : '';
  return `Numbers changed to ${numbers}.${updated}${kept}`;
}
