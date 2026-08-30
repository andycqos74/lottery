/**
 * Member contact — GAP-30 (channel undefined) and GAP-05 ⛔ (no email addresses
 * exist anywhere in the legacy register).
 *
 * "Fully online" implies email; the register holds none. So the port is
 * channel-agnostic and every send records an outcome per member, because
 * FR-12.1 requires knowing who was sent what, when, and with what result.
 */
import type { IdempotencyKey } from './errors.js';

export type ContactChannel = 'email' | 'sms' | 'post' | 'via_agent';

export interface NotificationRequest {
  readonly idempotencyKey: IdempotencyKey;
  /** Identifier only. The adapter resolves the actual address from the database. */
  readonly memberRef: string;
  readonly channel: ContactChannel;
  readonly templateId: string;
  /**
   * Merge values. These DO contain personal data by nature, which is exactly why
   * a notification is dispatched from an ACTIVITY that fetches them at send time,
   * rather than from a workflow that would persist them into history (T-9.5).
   */
  readonly mergeData: Readonly<Record<string, string>>;
}

export type DeliveryOutcome =
  | { readonly status: 'accepted'; readonly providerRef: string }
  | { readonly status: 'rejected'; readonly reasonCode: string; readonly reason: string };

export interface Notifier {
  readonly providerName: string;
  send(request: NotificationRequest): Promise<DeliveryOutcome>;
  /** Bounces and undeliverables — FR-5.5, a failure is a business event, not a log line. */
  fetchDeliveryEvents(since: string): Promise<
    readonly { readonly providerRef: string; readonly status: 'delivered' | 'bounced' | 'complained'; readonly at: string }[]
  >;
}

/**
 * Print and postal handoff. NFR-4: non-digital members must not be excluded —
 * 782 sit behind an agent, 25 have unusable postal data, and none has an email.
 * The member letter already exists as a mail-merge .docx with bracketed
 * placeholders, so at minimum the system generates the merge data.
 */
export interface PrintHandoff {
  readonly providerName: string;
  submitBatch(request: {
    readonly idempotencyKey: IdempotencyKey;
    readonly campaignRef: string;
    /** Object store key for the merge data. Never inline — T-9.5. */
    readonly mergeDataRef: string;
    readonly itemCount: number;
  }): Promise<{ readonly batchRef: string; readonly acceptedCount: number }>;
}
