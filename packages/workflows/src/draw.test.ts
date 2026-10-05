/**
 * DrawWorkflow, tested against a real Temporal test server via
 * TestWorkflowEnvironment — the first workflow-level test in this repo.
 * Everything else (`identify_winners`, `settle_draw`, the GAP-24 block) was
 * previously only proven by live manual runs against the dev stack.
 *
 * Mirrors packages/db/src/security.integration.test.ts's opt-in pattern:
 * TestWorkflowEnvironment.createLocal() downloads a test-server binary on
 * first use, which needs network access this sandbox may not have — so this
 * suite SKIPS by default rather than failing a green run that never actually
 * exercised it. Opt in with TEST_WORKFLOW_ENV=1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { WorkflowHandle } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import type { createActivities, OpenTaskRequest } from '@qosfc/activities';
import {
  DrawWorkflow,
  mustBeWonDecision,
  retryDraw,
  getState,
  type DrawState,
  type MustBeWonDecision,
} from './draw.js';

const enabled = process.env['TEST_WORKFLOW_ENV'] === '1';
const describeWf = enabled ? describe : describe.skip;

type FakeActivities = Partial<ReturnType<typeof createActivities>>;

describeWf('DrawWorkflow (TestWorkflowEnvironment)', () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createLocal();
  }, 60_000);

  afterAll(async () => {
    await testEnv?.teardown();
  });

  async function runInWorker<T>(
    input: { drawId: string; drawNumber: number; entriesCount: number },
    activities: FakeActivities,
    fn: (handle: WorkflowHandle<typeof DrawWorkflow>) => Promise<T>,
  ) {
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'draw',
      workflowsPath: fileURLToPath(new URL('../dist/draw.js', import.meta.url)),
      activities: {
        // No previous draw, entries generate cleanly, the frozen count is the
        // fixture's, and nobody matched anything — unless a test says otherwise.
        getRolloverIn: async () => ({ rolloverInPence: '0', fromDrawId: null }),
        generateDueEntries: async () => ({ candidatesConsidered: 0, generated: 0, directDebitGenerated: 0 }),
        closeDrawForRun: async () => ({ entriesCount: input.entriesCount }),
        countRollDownTiers: async () => ({ match3: 0, match2: 0, match1: 0 }),
        ...activities,
      },
    });

    return worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(DrawWorkflow, {
        taskQueue: 'draw',
        workflowId: `test-draw-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        args: [input],
      });
      return fn(handle);
    });
  }

  async function waitForStatus(
    handle: WorkflowHandle<typeof DrawWorkflow>,
    status: DrawState['status'],
    timeoutMs = 5000,
  ): Promise<DrawState> {
    const deadline = Date.now() + timeoutMs;
    let last: DrawState;
    do {
      last = await handle.query<DrawState, []>(getState);
      if (last.status === status) return last;
      await new Promise((r) => setTimeout(r, 50));
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for status '${status}'; last seen '${last.status}'.`);
  }

  // 100 entries -> prize contribution 10,000p, under both the 50,000p floor
  // and the 2,000,000p must-be-won cap. Never triggers GAP-24.
  const SMALL_DRAW = { drawId: 'draw-fixture-small', drawNumber: 1, entriesCount: 100 };
  // 25,000 entries -> prize contribution 2,500,000p, over the cap.
  const CAPPED_DRAW = { drawId: 'draw-fixture-capped', drawNumber: 2, entriesCount: 25_000 };

  it('settles cleanly when there are no winners', async () => {
    const state = await runInWorker(
      SMALL_DRAW,
      {
        generateWinningNumbers: async () => ({ numbers: [1, 2, 3, 4], source: 'fake', seed: 'fake' }),
        identifyWinners: async () => ({ winningEntries: [] }),
        settleDraw: async (req) => ({
          winnersCount: 0,
          jackpotPaidPence: '0',
          rolloverOutPence: req.jackpotPreDrawPence,
        }),
      },
      (handle) => handle.result(),
    );
    expect(state.status).toBe('settled');
    expect(state.winnersCount).toBe(0);
    expect(state.jackpotPaidPence).toBe('0');
  });

  it('GAP-24 residual: blocks when nobody matched even one number, then settles once a valid decision arrives', async () => {
    const state = await runInWorker(
      CAPPED_DRAW,
      {
        generateWinningNumbers: async () => ({ numbers: [1, 2, 3, 4], source: 'fake', seed: 'fake' }),
        identifyWinners: async () => ({ winningEntries: [] }),
        openHumanTask: async () => ({ taskId: 'fake-task', created: true }),
        settleDraw: async (req) => ({
          winnersCount: 0,
          jackpotPaidPence: '0',
          rolloverOutPence: req.jackpotPreDrawPence,
        }),
      },
      async (handle) => {
        const blocked = await waitForStatus(handle, 'blocked');
        expect(blocked.blockedOn).toContain('GAP-24');

        const decision: MustBeWonDecision = {
          mechanism: 'test-fixture-only',
          decidedBy: 'alice@example.com',
          secondApproverId: 'bob@example.com',
          note: 'test',
        };
        await handle.signal(mustBeWonDecision, decision);
        return handle.result();
      },
    );
    expect(state.status).toBe('settled');
  });

  it('GAP-44: rejects a must-be-won decision with the same first and second approver', async () => {
    await expect(
      runInWorker(
        CAPPED_DRAW,
        {
          generateWinningNumbers: async () => ({ numbers: [1, 2, 3, 4], source: 'fake', seed: 'fake' }),
          identifyWinners: async () => ({ winningEntries: [] }),
          openHumanTask: async () => ({ taskId: 'fake-task', created: true }),
        },
        async (handle) => {
          const decision: MustBeWonDecision = {
            mechanism: 'test-fixture-only',
            decidedBy: 'alice@example.com',
            secondApproverId: 'alice@example.com',
            note: 'test',
          };
          await handle.signal(mustBeWonDecision, decision);
          return handle.result();
        },
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining('GAP-44'),
      }),
    });
  });

  it('a real winner correctly prevents the must-be-won block, even at cap-triggering jackpot size', async () => {
    const state = await runInWorker(
      CAPPED_DRAW,
      {
        generateWinningNumbers: async () => ({ numbers: [1, 2, 3, 4], source: 'fake', seed: 'fake' }),
        identifyWinners: async () => ({ winningEntries: [{ entryId: 'e1', memberId: 'm1' }] }),
        settleDraw: async () => ({ winnersCount: 1, jackpotPaidPence: '2500000', rolloverOutPence: '0' }),
        notifyWinners: async () => ({ notified: 1, pending: 0 }),
      },
      (handle) => handle.result(),
    );
    expect(state.status).toBe('settled');
    expect(state.winnersCount).toBe(1);
    expect(state.blockedOn).toBeUndefined();
    expect(state.winnersNotified).toBe(1);
  });

  it('GitHub #10: carries the previous draw rollover into this jackpot and records it at settlement', async () => {
    let settledWith: { jackpotPreDrawPence: string; rolloverInPence?: string } | undefined;
    const state = await runInWorker(
      SMALL_DRAW,
      {
        getRolloverIn: async () => ({ rolloverInPence: '50000', fromDrawId: 'draw-before' }),
        generateWinningNumbers: async () => ({ numbers: [1, 2, 3, 4], source: 'fake', seed: 'fake' }),
        identifyWinners: async () => ({ winningEntries: [] }),
        settleDraw: async (req) => {
          settledWith = req;
          return { winnersCount: 0, jackpotPaidPence: '0', rolloverOutPence: req.jackpotPreDrawPence };
        },
      },
      (handle) => handle.result(),
    );
    // 100 entries -> 10,000p prize share, plus the 50,000p rolled in: above the floor, so no top-up.
    expect(state.jackpotPreDrawPence).toBe('60000');
    expect(settledWith).toMatchObject({ jackpotPreDrawPence: '60000', rolloverInPence: '50000', floorTopupPence: '0' });
  });

  it('GAP-24: rolls a must-be-won jackpot down to the first tier with a winner, without blocking', async () => {
    let settledWith: { mustBeWonRollDown?: boolean; winningEntries: readonly unknown[] } | undefined;
    let tasksOpened = 0;
    const state = await runInWorker(
      CAPPED_DRAW,
      {
        generateWinningNumbers: async () => ({ numbers: [1, 2, 3, 4], source: 'fake', seed: 'fake' }),
        identifyWinners: async () => ({ winningEntries: [] }),
        countRollDownTiers: async () => ({ match3: 0, match2: 2, match1: 40 }),
        openHumanTask: async () => {
          tasksOpened++;
          return { taskId: 'fake-task', created: true };
        },
        settleDraw: async (req) => {
          settledWith = req;
          return { winnersCount: 2, jackpotPaidPence: req.jackpotPreDrawPence, rolloverOutPence: '0', mustBeWonTier: 2 };
        },
        notifyWinners: async () => ({ notified: 2, pending: 0 }),
      },
      (handle) => handle.result(),
    );
    expect(tasksOpened).toBe(0);
    expect(settledWith).toMatchObject({ mustBeWonRollDown: true, winningEntries: [] });
    expect(state).toMatchObject({ status: 'settled', winnersCount: 2, mustBeWonTier: 2, winnersNotified: 2 });
    expect(state.blockedOn).toBeUndefined();
  });

  it('freezes the entry set itself: generates entries, closes the draw, and computes the jackpot from the frozen count', async () => {
    const calls: string[] = [];
    let settledWith: { jackpotPreDrawPence: string } | undefined;
    const state = await runInWorker(
      // The input count is ignored — the count closeDrawForRun froze is what counts.
      { drawId: 'draw-fixture-frozen', drawNumber: 3, entriesCount: 0 },
      {
        generateDueEntries: async () => {
          calls.push('generate');
          return { candidatesConsidered: 10, generated: 10, directDebitGenerated: 4 };
        },
        closeDrawForRun: async (req) => {
          calls.push(`close:${req.workflowId.startsWith('test-draw-') ? 'own-run' : req.workflowId}`);
          return { entriesCount: 600 };
        },
        generateWinningNumbers: async () => {
          calls.push('rng');
          return { numbers: [1, 2, 3, 4], source: 'fake', seed: 'fake' };
        },
        identifyWinners: async () => ({ winningEntries: [] }),
        settleDraw: async (req) => {
          settledWith = req;
          return { winnersCount: 0, jackpotPaidPence: '0', rolloverOutPence: req.jackpotPreDrawPence };
        },
      },
      (handle) => handle.result(),
    );
    expect(calls).toEqual(['generate', 'close:own-run', 'rng']);
    // 600 entries x 200p x 50% = 60,000p, above the 50,000p floor.
    expect(settledWith?.jackpotPreDrawPence).toBe('60000');
    expect(state.status).toBe('settled');
  });

  it('blocks on a task when entries cannot be generated, and retries when the task is resolved', async () => {
    let attempts = 0;
    const opened: OpenTaskRequest[] = [];
    const state = await runInWorker(
      SMALL_DRAW,
      {
        generateDueEntries: async () => {
          attempts++;
          if (attempts === 1) throw ApplicationFailure.nonRetryable('GAP-17 is not activated.', 'UnresolvedGapError');
          return { candidatesConsidered: 0, generated: 0, directDebitGenerated: 0 };
        },
        openHumanTask: async (req) => {
          opened.push(req);
          return { taskId: 'fake-task', created: true };
        },
        generateWinningNumbers: async () => ({ numbers: [1, 2, 3, 4], source: 'fake', seed: 'fake' }),
        identifyWinners: async () => ({ winningEntries: [] }),
        settleDraw: async (req) => ({ winnersCount: 0, jackpotPaidPence: '0', rolloverOutPence: req.jackpotPreDrawPence }),
      },
      async (handle) => {
        const blocked = await waitForStatus(handle, 'blocked');
        expect(blocked.blockedOn).toBe('entry generation failed');
        await handle.signal(retryDraw);
        return handle.result();
      },
    );
    expect(attempts).toBe(2);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ kind: 'draw_entries_failed', signalName: 'retry_draw', entityId: SMALL_DRAW.drawId });
    expect(opened[0]!.detail).toContain('GAP-17 is not activated.');
    expect(state.status).toBe('settled');
  });
});
