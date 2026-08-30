/**
 * Direct Debit — GAP-10 ⛔ (bureau vs GoCardless vs own SUN undecided).
 *
 * The asynchronous, days-long shape is exactly why P4 is a workflow: a submission
 * today produces results in three working days, mandate messages arrive out of
 * band, and an indemnity claim can arrive months after the collection that caused
 * it (T-5.5). The message SET differs per route and cannot be pinned down yet;
 * the SHAPE does not, and that is what this captures.
 */
import type { IdempotencyKey } from './errors.js';
import type { PenceString } from './payment-gateway.js';

export interface MandateRequest {
  readonly idempotencyKey: IdempotencyKey;
  /** Identifier only. The bureau collects bank details directly from the member. */
  readonly memberRef: string;
  readonly returnUrl: string;
}

export interface Mandate {
  readonly mandateRef: string;
  readonly status: 'pending' | 'active' | 'cancelled' | 'failed';
  readonly setupRedirectUrl?: string;
}

export interface CollectionInstruction {
  readonly memberRef: string;
  readonly mandateRef: string;
  readonly amountPence: PenceString;
}

export interface SubmissionReceipt {
  readonly submissionId: string;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  /** Validation rejections are PERMANENT (T-5.6): raise a task, never resubmit. */
  readonly rejections: readonly { readonly memberRef: string; readonly reasonCode: string; readonly reason: string }[];
  /** When results become available. Drives the workflow's durable sleep. */
  readonly resultsExpectedAt: string;
}

export type CollectionResult =
  | { readonly memberRef: string; readonly status: 'collected'; readonly amountPence: PenceString }
  | { readonly memberRef: string; readonly status: 'failed'; readonly reasonCode: string; readonly reason: string };

/** AUDDIS/ADDACS-shaped lifecycle messages, which arrive whenever they arrive. */
export interface MandateEvent {
  readonly eventId: string;
  readonly mandateRef: string;
  readonly memberRef: string;
  readonly kind: 'mandate_active' | 'mandate_cancelled' | 'mandate_amended' | 'mandate_failed' | 'indemnity_claim';
  readonly occurredAt: string;
  readonly detail: string;
  /** Present on an indemnity claim: the Direct Debit Guarantee makes these near-automatic (GAP-12). */
  readonly amountPence?: PenceString;
}

export interface BacsBureau {
  readonly providerName: string;
  /** Working days between submission and results. Route-dependent — GAP-10. */
  readonly settlementDays: number;

  createMandate(request: MandateRequest): Promise<Mandate>;
  getMandate(mandateRef: string): Promise<Mandate>;

  /**
   * T-5.6: carries the cycle key as its idempotency key, so a retry after a
   * timeout cannot collect from 600 members twice.
   */
  submitCollections(request: {
    readonly idempotencyKey: IdempotencyKey;
    readonly cycleKey: string;
    readonly instructions: readonly CollectionInstruction[];
  }): Promise<SubmissionReceipt>;

  fetchCollectionResults(submissionId: string): Promise<
    { readonly ready: false } | { readonly ready: true; readonly results: readonly CollectionResult[] }
  >;

  /** Polled or webhook-delivered; either way routed to the member's workflow (T-5.5). */
  fetchMandateEvents(since: string): Promise<readonly MandateEvent[]>;
}
