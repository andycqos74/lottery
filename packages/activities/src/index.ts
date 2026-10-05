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
import {
  countRollDownTiers,
  identifyWinners,
  type CountRollDownTiersRequest,
  type IdentifyWinnersRequest,
} from './draw/winners.js';
import {
  checkDrawProgress,
  closeDrawForRun,
  findDueDraws,
  type CheckDrawProgressRequest,
  type CloseDrawForRunRequest,
} from './draw/run.js';
import { generateDueEntries, type GenerateDueEntriesRequest } from './draw/generate-entries.js';
import {
  escalateTask,
  getTaskEscalationState,
  listTasksAwaitingEscalation,
  markEscalationStarted,
  type EscalateTaskRequest,
  type GetTaskEscalationStateRequest,
  type ListTasksAwaitingEscalationRequest,
  type MarkEscalationStartedRequest,
} from './tasks/escalation.js';
import { settleDraw, type SettleDrawRequest } from './draw/settle.js';
import { getRolloverIn, type GetRolloverInRequest } from './draw/rollover.js';
import { notifyWinners, type NotifyWinnersRequest } from './draw/notify-winners.js';
import { ingestNewStatements, type IngestNewStatementsRequest } from './reconcile/ingest-statement.js';
import { recordManualTicket, type RecordManualTicketRequest } from './entries/record-manual-ticket.js';

export function createActivities(ctx: ActivityContext) {
  return {
    openHumanTask: (request: OpenTaskRequest) => openHumanTask(ctx.pool, request),

    generateWinningNumbers: (request: GenerateNumbersRequest) =>
      generateWinningNumbers(ctx.pool, ctx.providers.randomness, request),

    identifyWinners: (request: IdentifyWinnersRequest) => identifyWinners(ctx.pool, request),

    countRollDownTiers: (request: CountRollDownTiersRequest) => countRollDownTiers(ctx.pool, request),

    findDueDraws: () => findDueDraws(ctx.pool),

    generateDueEntries: (request: GenerateDueEntriesRequest) => generateDueEntries(ctx.pool, request),

    closeDrawForRun: (request: CloseDrawForRunRequest) => closeDrawForRun(ctx.pool, request),

    checkDrawProgress: (request: CheckDrawProgressRequest) => checkDrawProgress(ctx.pool, request),

    listTasksAwaitingEscalation: (request: ListTasksAwaitingEscalationRequest) => listTasksAwaitingEscalation(ctx.pool, request),

    markEscalationStarted: (request: MarkEscalationStartedRequest) => markEscalationStarted(ctx.pool, request),

    getTaskEscalationState: (request: GetTaskEscalationStateRequest) => getTaskEscalationState(ctx.pool, request),

    escalateTask: (request: EscalateTaskRequest) => escalateTask(ctx.pool, request),

    getRolloverIn: (request: GetRolloverInRequest) => getRolloverIn(ctx.pool, request),

    settleDraw: (request: SettleDrawRequest) => settleDraw(ctx.pool, request),

    notifyWinners: (request: NotifyWinnersRequest) => notifyWinners(ctx.pool, ctx.providers.notifier, request),

    ingestNewBankStatements: (request: IngestNewStatementsRequest) => ingestNewStatements(ctx.pool, ctx.providers.bankFeed, request),

    recordManualTicket: (request: RecordManualTicketRequest) => recordManualTicket(ctx.pool, request),

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
export type {
  IdentifyWinnersRequest,
  IdentifyWinnersResult,
  CountRollDownTiersRequest,
  CountRollDownTiersResult,
} from './draw/winners.js';
export type {
  DueDraw,
  FindDueDrawsResult,
  CloseDrawForRunRequest,
  CloseDrawForRunResult,
  CheckDrawProgressRequest,
  CheckDrawProgressResult,
} from './draw/run.js';
export {
  ESCALATION_INTERVAL_MS,
  type TaskEscalationState,
  type EscalateTaskRequest,
  type EscalateTaskResult,
} from './tasks/escalation.js';
export type { SettleDrawRequest, SettleDrawResult } from './draw/settle.js';
export { getRolloverIn, type GetRolloverInRequest, type GetRolloverInResult } from './draw/rollover.js';
export type { NotifyWinnersRequest, NotifyWinnersResult } from './draw/notify-winners.js';
export { ingestNewStatements } from './reconcile/ingest-statement.js';
export type { IngestNewStatementsRequest, IngestedStatement } from './reconcile/ingest-statement.js';
export {
  matchBankTransaction,
  acceptBankTransactionMatchTx,
  type MatchOutcome,
  type AcceptMatchOutcome,
} from './reconcile/match-transactions.js';
export { generateDueEntries, type GenerateDueEntriesRequest, type GenerateDueEntriesResult } from './draw/generate-entries.js';
export {
  allocateUpcomingEntries,
  WEEK_CHANNELS,
  type AllocateUpcomingEntriesRequest,
  type AllocateUpcomingEntriesResult,
} from './draw/allocate-upcoming.js';
export {
  recordManualTicket,
  type RecordManualTicketRequest,
  type RecordManualTicketOutcome,
  type ManualTicketSelectionInput,
} from './entries/record-manual-ticket.js';
export { writeAudit, type AuditRecord } from './audit.js';
export { estimateStandingOrderEntries } from './draw/standing-order-estimate.js';
export { resolveLine, describeLineOutcome, type ResolvedLine } from './entries/lines.js';
export { ON_SALE_DRAWS_SQL } from './draw/place-entry.js';
