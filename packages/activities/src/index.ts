/**
 * Activity registry.
 *
 * Every activity is I/O (T-1.2): database writes, PSP calls, Bacs submissions,
 * bank feed reads, notifications, OCR, and the draw RNG. Workflow code calls
 * these; it performs no I/O of its own.
 *
 * They are created as a closure over the context so the worker can wire real
 * dependencies and a test can wire fakes, without either reaching for globals.
 */
import type { ActivityContext } from './context.js';
import { openHumanTask, type OpenTaskRequest } from './tasks/human-tasks.js';
import { generateWinningNumbers, type GenerateNumbersRequest } from './draw/rng.js';

export function createActivities(ctx: ActivityContext) {
  return {
    openHumanTask: (request: OpenTaskRequest) => openHumanTask(ctx.pool, request),

    generateWinningNumbers: (request: GenerateNumbersRequest) =>
      generateWinningNumbers(ctx.pool, ctx.providers.randomness, request),

    /** Which providers this worker is actually talking to — used by the Phase 1 gate. */
    describeProviders: async () => ({
      randomness: ctx.providers.randomness.kind,
      paymentGateway: ctx.providers.paymentGateway.providerName,
      bacsBureau: ctx.providers.bacsBureau.providerName,
      bankFeed: ctx.providers.bankFeed.providerName,
      notifier: ctx.providers.notifier.providerName,
    }),
  };
}

export type { ActivityContext } from './context.js';
export type { OpenTaskRequest, OpenTaskResult } from './tasks/human-tasks.js';
export type { GenerateNumbersRequest, GenerateNumbersResult } from './draw/rng.js';
export { writeAudit, type AuditRecord } from './audit.js';
