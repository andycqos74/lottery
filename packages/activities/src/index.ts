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
import { identifyWinners, type IdentifyWinnersRequest } from './draw/winners.js';
import { settleDraw, type SettleDrawRequest } from './draw/settle.js';
import { ingestNewStatements, type IngestNewStatementsRequest } from './reconcile/ingest-statement.js';

export function createActivities(ctx: ActivityContext) {
  return {
    openHumanTask: (request: OpenTaskRequest) => openHumanTask(ctx.pool, request),

    generateWinningNumbers: (request: GenerateNumbersRequest) =>
      generateWinningNumbers(ctx.pool, ctx.providers.randomness, request),

    identifyWinners: (request: IdentifyWinnersRequest) => identifyWinners(ctx.pool, request),

    settleDraw: (request: SettleDrawRequest) => settleDraw(ctx.pool, request),

    ingestNewBankStatements: (request: IngestNewStatementsRequest) => ingestNewStatements(ctx.pool, ctx.providers.bankFeed, request),

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
export type { IdentifyWinnersRequest, IdentifyWinnersResult } from './draw/winners.js';
export type { SettleDrawRequest, SettleDrawResult } from './draw/settle.js';
export { ingestNewStatements } from './reconcile/ingest-statement.js';
export type { IngestNewStatementsRequest, IngestedStatement } from './reconcile/ingest-statement.js';
export { matchBankTransaction, type MatchOutcome } from './reconcile/match-transactions.js';
export { writeAudit, type AuditRecord } from './audit.js';
