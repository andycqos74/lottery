/**
 * GAP-13 — lines with no numbers a week after issue get RANDOM.ORG numbers,
 * every line different, and the member is told by email or by a task to post
 * them. Agent-collected numbers are left alone (GAP-19, option c).
 *
 * Set TEST_APP_DB_URL to run. Without it the suite skips rather than silently
 * passing, so a green CI run with no database does not look like proof.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPool, migrate, type Pool } from '@qosfc/db';
import type { Selection } from '@qosfc/domain';
import type { DeliveryOutcome, NotificationRequest, Notifier, RandomnessSource, RandomnessSourceKind } from '@qosfc/ports';
import { allocateRandomSelections, POST_ALLOCATED_NUMBERS_TASK_KIND } from './random-allocation.js';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

/** Hands out scripted draws in order, so a clash with another line can be forced. */
function scriptedSource(draws: Selection[], kind: RandomnessSourceKind = 'random_org'): RandomnessSource & { calls: number } {
  const source = {
    kind,
    calls: 0,
    generateWinningNumbers: async ({ drawId }: { drawId: string }) => {
      const numbers = draws[source.calls++];
      if (!numbers) throw new Error('scripted source ran out of draws');
      return { numbers, evidence: { source: kind, seed: drawId, generatedAt: new Date(0).toISOString(), evidence: {} } };
    },
  };
  return source;
}

function recordingNotifier(): Notifier & { sent: NotificationRequest[] } {
  const sent: NotificationRequest[] = [];
  return {
    providerName: 'test',
    sent,
    send: async (request): Promise<DeliveryOutcome> => {
      sent.push(request);
      return { status: 'accepted', providerRef: `ref-${sent.length}` };
    },
    fetchDeliveryEvents: async () => [],
  };
}

describeDb('random allocation for lines with no numbers (GAP-13)', () => {
  let pool: Pool;

  async function member(surname: string, email: string | null, opts: { address?: boolean } = {}): Promise<string> {
    return (
      await pool.query(
        `INSERT INTO member (forename, surname, email, address_1, post_code) VALUES ('Test', $1, $2, $3, $4) RETURNING id`,
        [surname, email, opts.address ? '1 High St' : null, opts.address ? 'G1 1AA' : null],
      )
    ).rows[0].id;
  }

  async function number(prizeDrawNo: number, memberId: string, daysOld: number, channel = 'direct_bank'): Promise<void> {
    await pool.query(
      `INSERT INTO member_number (prize_draw_no, member_id, row_type, legacy_channel, created_at)
       VALUES ($1, $2, 'member', $3::legacy_channel, now() - make_interval(days => $4))`,
      [prizeDrawNo, memberId, channel, daysOld],
    );
  }

  async function selections(memberId: string): Promise<{ prize_draw_no: number; selection: number[]; source: string; notified: boolean }[]> {
    return (
      await pool.query(
        `SELECT ss.prize_draw_no, ss.selection, ss.source::text, ss.allocation_notified_at IS NOT NULL AS notified
           FROM selection_standing ss JOIN member_number mn ON mn.prize_draw_no = ss.prize_draw_no
          WHERE mn.member_id = $1 ORDER BY ss.prize_draw_no`,
        [memberId],
      )
    ).rows;
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-random-allocation-test', max: 4 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const here = dirname(fileURLToPath(import.meta.url));
    await migrate(pool, resolve(here, '../../../../db/migrations'), () => {});
    await pool.query(
      `INSERT INTO config_version (entry_strategy, entry_strategy_confirmed_by, note, is_active)
       VALUES ('prepaid_blocks', 'test fixture', 'random allocation fixture', true)`,
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('refuses to allocate from anything but RANDOM.ORG', async () => {
    const m = await member('Csprng', 'c@example.com');
    await number(900, m, 8);
    await expect(allocateRandomSelections(pool, scriptedSource([], 'csprng'), recordingNotifier(), {})).rejects.toThrow(/RANDOM\.ORG/);
    expect(await selections(m)).toEqual([]);
    await pool.query(`UPDATE member SET status = 'cancelled' WHERE id = $1`, [m]);
  });

  it('allocates after a week, keeps each line different, and tells the member by email or by post', async () => {
    const emailed = await member('Emailed', 'e@example.com');
    await number(1001, emailed, 8);

    const posted = await member('Posted', null, { address: true });
    await number(2001, posted, 8);
    await number(2002, posted, 8);

    const tooSoon = await member('Toosoon', 's@example.com');
    await number(3001, tooSoon, 2);

    const agentCollected = await member('Viaagent', null);
    await number(4001, agentCollected, 30, 'agent_collected');

    const chose = await member('Chose', 'ch@example.com');
    await number(5001, chose, 30);
    await pool.query(`INSERT INTO selection_standing (prize_draw_no, slot, selection, source) VALUES (5001, 1, '{9,10,11,12}', 'member_chosen')`);

    // 1001 → 1-2-3-4; 2001 → 1-2-3-4; 2002 draws 1-2-3-4 again (clash with 2001) then 5-6-7-8.
    const source = scriptedSource([
      [1, 2, 3, 4],
      [1, 2, 3, 4],
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    const notifier = recordingNotifier();
    const result = await allocateRandomSelections(pool, source, notifier, {});

    expect(result).toEqual({ allocated: 3, emailed: 1, postTasks: 1 });
    expect(source.calls).toBe(4);

    expect(await selections(emailed)).toEqual([{ prize_draw_no: 1001, selection: [1, 2, 3, 4], source: 'randomly_allocated', notified: true }]);
    expect((await selections(posted)).map((s) => s.selection)).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    expect(await selections(tooSoon)).toEqual([]);
    expect(await selections(agentCollected)).toEqual([]);
    expect((await selections(chose)).map((s) => s.source)).toEqual(['member_chosen']);

    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({ memberRef: emailed, channel: 'email', templateId: 'numbers_allocated' });
    expect(notifier.sent[0]!.mergeData['lines']).toBe('1 · 2 · 3 · 4 (prize draw no. 1001)');

    const { rows: tasks } = await pool.query(`SELECT entity_id, title, detail FROM human_task WHERE kind = $1`, [POST_ALLOCATED_NUMBERS_TASK_KIND]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ entity_id: posted, title: 'Post Test Posted their lottery numbers' });
    expect(tasks[0].detail).toContain('1 · 2 · 3 · 4 (prize draw no. 2001); 5 · 6 · 7 · 8 (prize draw no. 2002)');

    const { rows: audit } = await pool.query(`SELECT 1 FROM audit_log WHERE action = 'selection.randomly_allocated'`);
    expect(audit).toHaveLength(3);
  });

  it('does nothing more on the next run', async () => {
    const notifier = recordingNotifier();
    expect(await allocateRandomSelections(pool, scriptedSource([]), notifier, {})).toEqual({ allocated: 0, emailed: 0, postTasks: 0 });
    expect(notifier.sent).toEqual([]);
  });
});
