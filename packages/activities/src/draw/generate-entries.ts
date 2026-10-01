/**
 * Entries for a draw about to be run — GAP-17 (prepaid blocks) and GitHub #9
 * (Direct Debit). Entries are normally made as soon as draws exist
 * (`allocateUpcomingEntries`, see there for the rules); this is the backstop
 * the admin console runs before closing a draw, so nobody who has paid is
 * left out because something earlier didn't run.
 */
import type { Pool } from '@qosfc/db';
import { allocateUpcomingEntries } from './allocate-upcoming.js';

export interface GenerateDueEntriesRequest {
  readonly drawId: string;
  readonly actorLabel: string;
  readonly actorId?: string;
}

export interface GenerateDueEntriesResult {
  readonly candidatesConsidered: number;
  /** Entries placed in this draw by this run, Direct Debit ones included. */
  readonly generated: number;
  readonly directDebitGenerated: number;
}

/**
 * The run-time backstop: before a draw's entry set is frozen, make sure
 * every line that should be in it is — the same rules as
 * `allocateUpcomingEntries` (paid weeks first, then Direct Debit), with this
 * draw included even though its entries have closed. Money or a mandate
 * arriving after its cutoff buys the next draw, not this one.
 */
export async function generateDueEntries(pool: Pool, request: GenerateDueEntriesRequest): Promise<GenerateDueEntriesResult> {
  const { rows } = await pool.query<{ status: string }>(`SELECT status FROM draw WHERE id = $1`, [request.drawId]);
  const draw = rows[0];
  if (!draw) throw new Error(`Draw ${request.drawId} does not exist.`);
  if (draw.status !== 'open') {
    throw new Error(`Draw ${request.drawId} is '${draw.status}', not 'open' — entries can only be generated before a draw closes.`);
  }
  const result = await allocateUpcomingEntries(pool, {
    includeDrawId: request.drawId,
    actorLabel: request.actorLabel,
    ...(request.actorId ? { actorId: request.actorId } : {}),
  });
  return {
    candidatesConsidered: result.membersConsidered,
    generated: result.placedInIncludedDraw,
    directDebitGenerated: result.directDebitPlacedInIncludedDraw,
  };
}
