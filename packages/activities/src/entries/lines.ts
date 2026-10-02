/**
 * Lines — a member's sets of numbers (db/migrations/0018) — and what to tell
 * the member when a purchase or Direct Debit setup lands on one.
 *
 * Client rules (2026-10-01): a purchase or setup with numbers the member
 * already has adds to that line; different numbers start a new line, an
 * extra entry alongside the existing ones. A member never holds two lines
 * with the same numbers, so never two entries in one draw with them.
 */
import type { Pool } from '@qosfc/db';
import type { PoolClient } from 'pg';
import { formatPence, pence, TICKET_PRICE_PENCE } from '@qosfc/domain';

export interface ResolvedLine {
  readonly prizeDrawNo: number;
  readonly slot: number;
  /** True when these numbers started a new line. */
  readonly isNew: boolean;
  /** The member's other current lines' numbers, for the message. */
  readonly otherSelections: readonly (readonly number[])[];
}

const sameNumbers = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i]);

/**
 * The line these numbers belong to, creating it if they are new. Call inside
 * the transaction that records the payment or mandate against it.
 */
export async function resolveLine(client: PoolClient, memberId: string, selection: readonly number[]): Promise<ResolvedLine> {
  const sorted = [...selection].sort((a, b) => a - b);
  const { rows: lines } = await client.query<{ prize_draw_no: number; slot: number; selection: number[] }>(
    `SELECT ss.prize_draw_no, ss.slot, ss.selection
       FROM selection_standing ss JOIN member_number mn ON mn.prize_draw_no = ss.prize_draw_no
      WHERE mn.member_id = $1 AND mn.row_type = 'member' AND ss.effective_to IS NULL
      ORDER BY ss.prize_draw_no, ss.slot`,
    [memberId],
  );
  const match = lines.find((l) => sameNumbers(l.selection, sorted));
  if (match) {
    return {
      prizeDrawNo: match.prize_draw_no,
      slot: match.slot,
      isNew: false,
      otherSelections: lines.filter((l) => l !== match).map((l) => l.selection),
    };
  }

  // A member keeps one prize draw number (FR-1.3); a new line is a new slot on it.
  const { rows: noRows } = await client.query<{ prize_draw_no: number }>(
    `SELECT prize_draw_no FROM member_number WHERE member_id = $1 AND row_type = 'member' ORDER BY prize_draw_no LIMIT 1`,
    [memberId],
  );
  let prizeDrawNo = noRows[0]?.prize_draw_no;
  if (prizeDrawNo === undefined) {
    const { rows: nextNoRows } = await client.query<{ next: number }>(`SELECT COALESCE(MAX(prize_draw_no), 99999) + 1 AS next FROM member_number`);
    prizeDrawNo = nextNoRows[0]!.next;
    await client.query(`INSERT INTO member_number (prize_draw_no, member_id, row_type) VALUES ($1, $2, 'member')`, [prizeDrawNo, memberId]);
  }
  // Never reuse a slot number, even a closed one: entry keys end in the slot.
  const { rows: slotRows } = await client.query<{ next: number }>(
    `SELECT COALESCE(MAX(slot), 0) + 1 AS next FROM selection_standing WHERE prize_draw_no = $1`,
    [prizeDrawNo],
  );
  const slot = slotRows[0]!.next;
  await client.query(`INSERT INTO selection_standing (prize_draw_no, slot, selection, source) VALUES ($1, $2, $3, 'member_chosen')`, [
    prizeDrawNo,
    slot,
    sorted,
  ]);
  return { prizeDrawNo, slot, isNew: true, otherSelections: lines.map((l) => l.selection) };
}

const LONDON_DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short' });

interface LineDraw {
  readonly drawNumber: number;
  readonly when: string;
  readonly funding: string;
}

async function lineState(pool: Pool, memberId: string, line: { prizeDrawNo: number; slot: number }) {
  const { rows: entries } = await pool.query<{ draw_number: number; draw_at: Date | null; draw_date: Date; funding_source: string }>(
    `SELECT d.draw_number, d.draw_at, d.draw_date, e.funding_source::text
       FROM entry e JOIN draw d ON d.id = e.draw_id
      WHERE e.member_id = $1 AND e.prize_draw_no = $2 AND e.selection_slot = $3 AND e.voided_at IS NULL AND d.status = 'open'
      ORDER BY COALESCE(d.draw_at, d.draw_date::timestamptz), d.draw_number`,
    [memberId, line.prizeDrawNo, line.slot],
  );
  // The member's first line also carries payments recorded before lines existed.
  const { rows: first } = await pool.query<{ prize_draw_no: number; slot: number }>(
    `SELECT ss.prize_draw_no, ss.slot FROM selection_standing ss JOIN member_number mn ON mn.prize_draw_no = ss.prize_draw_no
      WHERE mn.member_id = $1 AND mn.row_type = 'member' AND ss.effective_to IS NULL ORDER BY ss.prize_draw_no, ss.slot LIMIT 1`,
    [memberId],
  );
  const isDefault = first[0]?.prize_draw_no === line.prizeDrawNo && first[0]?.slot === line.slot;
  const { rows: paid } = await pool.query<{ weeks: string; used: string }>(
    `SELECT
       (SELECT COALESCE(SUM(amount_pence), 0) FROM payment
         WHERE member_id = $1 AND status = 'allocated' AND channel IN ('so_fps','giro','branch_cash','agent_cash','card')
           AND ((line_prize_draw_no = $2 AND line_slot = $3) OR (line_prize_draw_no IS NULL AND $4)))::bigint / $5 AS weeks,
       (SELECT count(*) FROM entry WHERE member_id = $1 AND prize_draw_no = $2 AND selection_slot = $3
          AND funding_source IN ('prepaid','card') AND voided_at IS NULL) AS used`,
    [memberId, line.prizeDrawNo, line.slot, isDefault, TICKET_PRICE_PENCE.toString()],
  );
  const draws: LineDraw[] = entries.map((e) => ({
    drawNumber: e.draw_number,
    when: LONDON_DAY.format(e.draw_at ?? e.draw_date),
    funding: e.funding_source,
  }));
  return { draws, weeksWaiting: Math.max(0, Number(paid[0]!.weeks) - Number(paid[0]!.used)) };
}

const label = (d: LineDraw) => `Draw ${d.drawNumber} (${d.when})`;
const numbers = (s: readonly number[]) => s.join(', ');

function listDraws(draws: readonly LineDraw[]): string {
  if (draws.length <= 4) return draws.map(label).join(', ');
  return `${label(draws[0]!)} to ${label(draws[draws.length - 1]!)} (${draws.length} draws)`;
}

/**
 * What to tell the member after a card purchase or Direct Debit setup, once
 * `allocateUpcomingEntries` has placed the entries — read back from what was
 * actually done, so the message can't promise something that didn't happen.
 */
export async function describeLineOutcome(
  pool: Pool,
  input: {
    memberId: string;
    line: ResolvedLine;
    selection: readonly number[];
    /** `ofSeveral`: one of several lines bought in the same payment (GitHub #19) — the caller says what the payment was. */
    event: { kind: 'card'; weeks: number; ofSeveral?: boolean } | { kind: 'direct_debit' };
  },
): Promise<string> {
  const { line, event } = input;
  const { draws, weeksWaiting } = await lineState(pool, input.memberId, line);
  const paidDraws = draws.filter((d) => d.funding === 'prepaid' || d.funding === 'card');
  const ddDraws = draws.filter((d) => d.funding === 'direct_debit');
  const firstDd = ddDraws[0];
  const parts: string[] = [];

  if (event.kind === 'card') {
    const amount = formatPence(pence(TICKET_PRICE_PENCE * BigInt(event.weeks)));
    if (event.ofSeveral) {
      parts.push(
        line.isNew
          ? `New numbers ${numbers(input.selection)}.`
          : `You already had the numbers ${numbers(input.selection)}, so ${event.weeks === 1 ? 'this draw has' : `these ${event.weeks} draws have`} been added to them.`,
      );
    } else if (!line.isNew) {
      parts.push(
        event.weeks === 1
          ? `You already had the numbers ${numbers(input.selection)}, so the draw you paid ${amount} for has been added to them.`
          : `You already had the numbers ${numbers(input.selection)}, so the ${event.weeks} draws you paid ${amount} for have been added to them.`,
      );
    } else if (line.otherSelections.length > 0) {
      parts.push(
        `These are new numbers, so they have been added as an extra entry alongside your existing numbers (${line.otherSelections.map(numbers).join('; ')}).`,
      );
    } else {
      parts.push(`Thank you — your ${amount} payment covers ${event.weeks} draw${event.weeks === 1 ? '' : 's'}.`);
    }
    if (paidDraws.length > 0) parts.push(`Your paid entries with these numbers: ${listDraws(paidDraws)}.`);
    if (weeksWaiting > 0) parts.push(`${weeksWaiting} more paid draw${weeksWaiting === 1 ? ' is' : 's are'} waiting and will be entered as further draws are scheduled.`);
    if (firstDd) {
      parts.push(`Your Direct Debit for these numbers is paused while your paid draws are used, and starts again from ${label(firstDd)}.`);
    }
  } else {
    if (line.isNew && line.otherSelections.length > 0) {
      parts.push(
        `These are new numbers, so your Direct Debit adds an extra entry in every draw, alongside your existing numbers (${line.otherSelections.map(numbers).join('; ')}).`,
      );
    } else if (!line.isNew) {
      parts.push(`Your Direct Debit is set up for your numbers ${numbers(input.selection)}.`);
    } else {
      parts.push(`Your Direct Debit is set up: your numbers ${numbers(input.selection)} are entered into every draw until you cancel.`);
    }
    if (paidDraws.length > 0) {
      parts.push(
        `You've already paid for ${listDraws(paidDraws)}${weeksWaiting > 0 ? ` and ${weeksWaiting} more draw${weeksWaiting === 1 ? '' : 's'}` : ''}, so those are used first` +
          (firstDd ? ` — your Direct Debit starts from ${label(firstDd)}.` : ' — your Direct Debit starts once they run out.'),
      );
    } else if (firstDd) {
      parts.push(`Entered by Direct Debit from ${label(firstDd)}${ddDraws.length > 1 ? `, and every draw after it` : ''}.`);
    } else {
      parts.push('You will be entered by Direct Debit as each new draw is scheduled.');
    }
  }
  return parts.join(' ');
}
