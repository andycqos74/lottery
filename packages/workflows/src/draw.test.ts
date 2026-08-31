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
import type { createActivities } from '@qosfc/activities';
import { DrawWorkflow, mustBeWonDecision, getState, type DrawState, type MustBeWonDecision } from './draw.js';

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
      activities,
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

  it('blocks on the GAP-24 must-be-won cap, then settles once a valid decision arrives', async () => {
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
      },
      (handle) => handle.result(),
    );
    expect(state.status).toBe('settled');
    expect(state.winnersCount).toBe(1);
    expect(state.blockedOn).toBeUndefined();
  });
});
