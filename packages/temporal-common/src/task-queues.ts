/**
 * Task queues, separated by workload class (T-10.19).
 *
 * The separation exists so a slow OCR batch cannot starve the draw. Each queue
 * gets its own worker container with its own memory limit, so the isolation is
 * enforced by the deployment rather than only by convention.
 */
export const TASK_QUEUES = {
  draw: 'draw',
  member: 'member',
  payments: 'payments',
  recon: 'recon',
  comms: 'comms',
  migration: 'migration',
} as const;

export type TaskQueue = (typeof TASK_QUEUES)[keyof typeof TASK_QUEUES];

export const ALL_TASK_QUEUES: readonly TaskQueue[] = Object.values(TASK_QUEUES);

export function assertTaskQueue(value: string): TaskQueue {
  if (!ALL_TASK_QUEUES.includes(value as TaskQueue)) {
    throw new Error(`Unknown task queue "${value}". Expected one of: ${ALL_TASK_QUEUES.join(', ')}.`);
  }
  return value as TaskQueue;
}

/**
 * Search attributes (T-10.7).
 *
 * On SQL-backed visibility these are namespace-scoped and must be registered
 * during provisioning: workflow code that sets an unregistered attribute fails at
 * RUNTIME, not at deploy. The worker asserts their presence at startup rather
 * than discovering the omission during a draw.
 */
export const SEARCH_ATTRIBUTES = {
  DrawNumber: 'Int',
  DrawStatus: 'Keyword',
  MemberNumber: 'Int',
  MemberStatus: 'Keyword',
  StatementNumber: 'Int',
  TaskKind: 'Keyword',
  Blocked: 'Bool',
  AmountPence: 'Int',
} as const;

export const NAMESPACE = process.env['TEMPORAL_NAMESPACE'] ?? 'qosfc-lottery';

/**
 * Workflow IDs are BUSINESS KEYS (T-8.1). This is what makes duplicate execution
 * structurally impossible rather than merely checked: `draw-2026-W37` cannot run
 * twice, because Temporal will not start a second workflow with that ID.
 */
export const workflowIds = {
  draw: (isoYear: number, isoWeek: number) => `draw-${isoYear}-W${String(isoWeek).padStart(2, '0')}`,
  member: (memberId: string) => `member-${memberId}`,
  onboarding: (signupId: string) => `onboard-${signupId}`,
  ddCollection: (cycleKey: string) => `dd-${cycleKey}`,
  prize: (prizeId: string) => `prize-${prizeId}`,
  reconciliation: (batchKey: string) => `recon-${batchKey}`,
  agentRemittance: (agentId: string, period: string) => `agent-${agentId}-${period}`,
  mailing: (campaignId: string) => `mail-${campaignId}`,
  complianceMonitor: () => 'compliance-monitor',
  statutoryReturn: (period: string) => `return-${period}`,
  migration: (runId: string) => `migration-${runId}`,
  escalation: (taskId: string) => `escalation-${taskId}`,
  drawWatchdog: (isoYear: number, isoWeek: number) =>
    `draw-watchdog-${isoYear}-W${String(isoWeek).padStart(2, '0')}`,
} as const;
