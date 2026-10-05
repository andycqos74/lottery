/**
 * The clock-driven workflows — draw dispatch, the draw watchdog, and task
 * escalation — against Temporal's time-skipping test server, so a 2-hour
 * watchdog or a 24-hour escalation runs in milliseconds.
 *
 * The dispatcher needs no timers, so it runs against its own ordinary local
 * server instead: sharing the time-skipping one, its terminated child runs
 * left that server unable to skip time for the tests after it.
 *
 * Opt-in, like draw.test.ts: the test server is downloaded on first use, so
 * this suite skips unless TEST_WORKFLOW_ENV=1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import type { createActivities, OpenTaskRequest, TaskEscalationState } from '@qosfc/activities';
import { DrawDispatchWorkflow, DrawWatchdogWorkflow } from './draw-dispatch.js';
import { EscalationSweepWorkflow, EscalationWorkflow, taskClosed } from './escalation.js';

const enabled = process.env['TEST_WORKFLOW_ENV'] === '1';
const describeWf = enabled ? describe : describe.skip;

type FakeActivities = Partial<ReturnType<typeof createActivities>>;

const HOUR = 60 * 60 * 1000;
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

describeWf('scheduled workflows (time-skipping TestWorkflowEnvironment)', () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120_000);

  afterAll(async () => {
    await testEnv?.teardown();
  });

  /** Workers for every queue these workflows start children on. */
  async function withWorkers<T>(activities: FakeActivities, fn: () => Promise<T>, env = testEnv): Promise<T> {
    const workflowsPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
    const [draw, comms] = await Promise.all(
      ['draw', 'comms'].map((taskQueue) =>
        Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath, activities }),
      ),
    );
    return draw!.runUntil(comms!.runUntil(fn));
  }

  describe('DrawDispatchWorkflow', () => {
    let localEnv: TestWorkflowEnvironment;

    beforeAll(async () => {
      localEnv = await TestWorkflowEnvironment.createLocal();
    }, 120_000);

    afterAll(async () => {
      await localEnv?.teardown();
    });

    it('starts one run per due draw, and a second pass finds it already running', async () => {
      const drawId = `due-${unique()}`;
      const result = await withWorkers(
        {
          findDueDraws: async () => ({ draws: [{ drawId, drawNumber: 7 }] }),
          // Park the started run on its entries-failed task, so the second pass
          // sees it running — with no activity in flight, which would stop the
          // worker shutting down.
          generateDueEntries: async () => {
            throw ApplicationFailure.nonRetryable('GAP-17 is not activated.');
          },
          openHumanTask: async () => ({ taskId: 'fake-task', created: true }),
        },
        async () => {
          const first = await localEnv.client.workflow.execute(DrawDispatchWorkflow, {
            taskQueue: 'draw',
            workflowId: `dispatch-${unique()}`,
          });
          const second = await localEnv.client.workflow.execute(DrawDispatchWorkflow, {
            taskQueue: 'draw',
            workflowId: `dispatch-${unique()}`,
          });
          const run = await localEnv.client.workflow.getHandle(`draw-${drawId}`).describe();
          const watchdog = await localEnv.client.workflow.getHandle(`draw-watchdog-${drawId}`).describe();
          await localEnv.client.workflow.getHandle(`draw-${drawId}`).terminate('test cleanup');
          await localEnv.client.workflow.getHandle(`draw-watchdog-${drawId}`).terminate('test cleanup');
          return { first, second, runType: run.type, watchdogType: watchdog.type };
        },
        localEnv,
      );
      expect(result.first).toEqual({ started: [drawId], alreadyRunning: [] });
      expect(result.second).toEqual({ started: [], alreadyRunning: [drawId] });
      expect(result.runType).toBe('DrawWorkflow');
      expect(result.watchdogType).toBe('DrawWatchdogWorkflow');
    });

    it('does nothing when no draw is due', async () => {
      const result = await withWorkers(
        { findDueDraws: async () => ({ draws: [] }) },
        () => localEnv.client.workflow.execute(DrawDispatchWorkflow, { taskQueue: 'draw', workflowId: `dispatch-${unique()}` }),
        localEnv,
      );
      expect(result).toEqual({ started: [], alreadyRunning: [] });
    });
  });

  describe('DrawWatchdogWorkflow', () => {
    async function runWatchdog(progress: { status: string; openTaskId: string | null }) {
      const opened: OpenTaskRequest[] = [];
      const outcome = await withWorkers(
        {
          checkDrawProgress: async () => progress,
          openHumanTask: async (req) => {
            opened.push(req);
            return { taskId: 'fake-task', created: true };
          },
        },
        () =>
          testEnv.client.workflow.execute(DrawWatchdogWorkflow, {
            taskQueue: 'draw',
            workflowId: `watchdog-${unique()}`,
            args: [{ drawId: 'draw-x', drawNumber: 9 }],
          }),
      );
      return { outcome, opened };
    }

    it('stays quiet when the draw settled in time', async () => {
      expect(await runWatchdog({ status: 'settled', openTaskId: null })).toEqual({ outcome: 'completed', opened: [] });
    });

    it('stays quiet when the run is parked on its own task, which escalates by itself', async () => {
      expect(await runWatchdog({ status: 'drawn', openTaskId: 't-1' })).toEqual({ outcome: 'blocked_on_task', opened: [] });
    });

    it('raises a task when the run has neither finished nor parked', async () => {
      const { outcome, opened } = await runWatchdog({ status: 'closed', openTaskId: null });
      expect(outcome).toBe('raised');
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({ kind: 'draw_overdue', entityId: 'draw-x', dedupeKey: 'draw_overdue:draw-x' });
    });
  });

  describe('EscalationWorkflow', () => {
    it('escalates each time the task goes overdue, and stops once it is resolved', async () => {
      // Open and not yet due → overdue → escalated once → overdue again →
      // escalated twice → resolved.
      const states: TaskEscalationState[] = [
        { status: 'open', escalationLevel: 0, msUntilOverdue: 24 * HOUR },
        { status: 'open', escalationLevel: 0, msUntilOverdue: 0 },
        { status: 'open', escalationLevel: 1, msUntilOverdue: 24 * HOUR },
        { status: 'open', escalationLevel: 1, msUntilOverdue: 0 },
        { status: 'resolved', escalationLevel: 2, msUntilOverdue: 0 },
      ];
      const escalations: number[] = [];
      const outcome = await withWorkers(
        {
          getTaskEscalationState: async () => states.shift()!,
          escalateTask: async (req) => {
            escalations.push(req.fromLevel);
            return { escalated: true, escalationLevel: req.fromLevel + 1 };
          },
        },
        () =>
          testEnv.client.workflow.execute(EscalationWorkflow, {
            taskQueue: 'comms',
            workflowId: `escalation-${unique()}`,
            args: [{ taskId: 't-1' }],
          }),
      );
      expect(outcome).toBe('task_closed');
      expect(escalations).toEqual([0, 1]);
    });

    it('ends as soon as the console signals the task closed, without escalating', async () => {
      let escalated = false;
      const outcome = await withWorkers(
        {
          getTaskEscalationState: async () => ({ status: 'open', escalationLevel: 0, msUntilOverdue: 24 * HOUR }),
          escalateTask: async (req) => {
            escalated = true;
            return { escalated: true, escalationLevel: req.fromLevel + 1 };
          },
        },
        async () => {
          const handle = await testEnv.client.workflow.start(EscalationWorkflow, {
            taskQueue: 'comms',
            workflowId: `escalation-${unique()}`,
            args: [{ taskId: 't-2' }],
          });
          await handle.signal(taskClosed);
          return handle.result();
        },
      );
      expect(outcome).toBe('task_closed');
      expect(escalated).toBe(false);
    });
  });

  describe('EscalationSweepWorkflow', () => {
    it('starts an escalation per open task, records them, and tolerates one already running', async () => {
      const taskA = `task-a-${unique()}`;
      const taskB = `task-b-${unique()}`;
      let marked: readonly { taskId: string; workflowId: string }[] = [];
      const activities: FakeActivities = {
        listTasksAwaitingEscalation: async () => ({ taskIds: [taskA, taskB] }),
        markEscalationStarted: async (req) => {
          marked = req.tasks;
        },
        // Not due for a day — the children stay running until terminated.
        getTaskEscalationState: async () => ({ status: 'open', escalationLevel: 0, msUntilOverdue: 24 * HOUR }),
      };
      const result = await withWorkers(activities, async () => {
        // An earlier sweep started A's escalation but died before recording it.
        await testEnv.client.workflow.start(EscalationWorkflow, {
          taskQueue: 'comms',
          workflowId: `escalation-${taskA}`,
          args: [{ taskId: taskA }],
        });
        const swept = await testEnv.client.workflow.execute(EscalationSweepWorkflow, {
          taskQueue: 'comms',
          workflowId: `sweep-${unique()}`,
        });
        const b = await testEnv.client.workflow.getHandle(`escalation-${taskB}`).describe();
        await testEnv.client.workflow.getHandle(`escalation-${taskA}`).terminate('test cleanup');
        await testEnv.client.workflow.getHandle(`escalation-${taskB}`).terminate('test cleanup');
        return { swept, bStatus: b.status.name };
      });
      expect(result.swept).toEqual({ started: 2 });
      expect(result.bStatus).toBe('RUNNING');
      expect(marked).toEqual([
        { taskId: taskA, workflowId: `escalation-${taskA}` },
        { taskId: taskB, workflowId: `escalation-${taskB}` },
      ]);
    });
  });
});
