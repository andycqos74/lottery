/**
 * Workflow IDs and task queues, as workflow code needs them.
 *
 * The canonical list is `workflowIds` / `TASK_QUEUES` in
 * packages/temporal-common/src/task-queues.ts — but that package bundles the
 * Temporal client and reads the environment, neither of which may enter the
 * workflow sandbox. These must stay identical to their counterparts there.
 */
export const DRAW_QUEUE = 'draw';
export const COMMS_QUEUE = 'comms';

/** A draw row is the business key: draws can be weekly, fortnightly or monthly, so an ISO week is not. */
export const drawWorkflowId = (drawId: string) => `draw-${drawId}`;
export const drawWatchdogId = (drawId: string) => `draw-watchdog-${drawId}`;
export const escalationWorkflowId = (taskId: string) => `escalation-${taskId}`;
