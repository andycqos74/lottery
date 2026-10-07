/**
 * Direct Debit (GAP-10 shape): mandates and monthly collections.
 *
 * Runs on the `direct-debit` Temporal Schedule. Each step asks the database
 * what is due and is safe to repeat, so a missed or late tick only delays
 * work by one interval — the next finds the same rows:
 *
 * 1. apply the bank's mandate messages (confirmations, cancellations, refund claims);
 * 2. cancel with the bureau every mandate ended here;
 * 3. prepare next month's collections and send the advance notices;
 * 4. submit the batches due today;
 * 5. read results that are in: payments, one retry, or the Direct Debit stops.
 *
 * Three-day settlement is a database timestamp the next run checks, not a
 * timer here, so a run lasts seconds. `asOf` (a UK date) is for dev runs
 * started by hand, to bring a collection month forward; the Schedule never
 * sets it. Activities return counts only (TG-11).
 */
import * as workflow from '@temporalio/workflow';
import type {
  createActivities,
  PrepareCollectionsResult,
  ProcessCollectionResultsResult,
  ProcessMandateEventsResult,
  SubmitDueCollectionsResult,
} from '@qosfc/activities';

const {
  ddProcessMandateEvents,
  ddCancelMandatesAtBureau,
  ddPrepareCollections,
  ddSubmitDueCollections,
  ddProcessCollectionResults,
} = workflow.proxyActivities<ReturnType<typeof createActivities>>({
  startToCloseTimeout: '10 minutes',
  retry: { initialInterval: '30s', backoffCoefficient: 2, maximumAttempts: 5 },
});

export interface DirectDebitInput {
  readonly asOf?: string;
}

export interface DirectDebitResult {
  readonly events: ProcessMandateEventsResult;
  readonly bureauCancellations: { readonly cancelled: number };
  readonly prepared: PrepareCollectionsResult;
  readonly submitted: SubmitDueCollectionsResult;
  readonly results: ProcessCollectionResultsResult;
}

export async function DirectDebitWorkflow(input: DirectDebitInput = {}): Promise<DirectDebitResult> {
  const step = input.asOf ? { asOf: input.asOf } : {};
  const events = await ddProcessMandateEvents();
  const bureauCancellations = await ddCancelMandatesAtBureau();
  const prepared = await ddPrepareCollections(step);
  const submitted = await ddSubmitDueCollections(step);
  const results = await ddProcessCollectionResults(step);
  return { events, bureauCancellations, prepared, submitted, results };
}
