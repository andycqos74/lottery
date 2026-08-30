/**
 * Bank statements — GAP-33 ⛔ (Open Banking vs CSV vs continued OCR undecided).
 *
 * GAP-33, held for now: manual CSV upload is assumed, with Open Banking and
 * continued OCR left as options for future development — see the sandbox's
 * `SandboxBankFeed` default `source`. This also carries GAP-09's "existing
 * standing order from bank account" dummy integration: a standing order needs
 * no PSP at all, it simply shows up here as an ordinary credit.
 *
 * All three candidates produce the same thing: statements with an opening and
 * closing balance, and credits with a reference. The difference is confidence —
 * OCR drops decimal points (T-5.7), Open Banking does not — so the port carries a
 * per-transaction confidence and the matching engine is written to use it. That
 * way the reconciliation build does not wait on the decision, and the decision
 * does not force a rewrite when it arrives.
 */
import type { PenceString } from './payment-gateway.js';

export type BankFeedSource = 'open_banking' | 'csv' | 'ocr_pdf';

export interface StatementSummary {
  readonly statementNumber: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly openingBalancePence: PenceString;
  readonly closingBalancePence: PenceString;
  readonly source: BankFeedSource;
  /** Object store key. T-9.5: never the bytes — statement scans are personal data. */
  readonly sourceRef: string;
}

export interface BankCredit {
  readonly externalId: string;
  readonly valueDate: string;
  readonly description: string;
  /** 'Transfer' | 'Standing Order' | 'Giro' | 'Branch' — 'Branch' means an agent bulk lodgement. */
  readonly typeRaw: string;
  readonly amountPence: PenceString;
  readonly isCredit: boolean;
  readonly extractedReference?: string;
  readonly extractedName?: string;
  /**
   * 0..1, or undefined for a source that does not guess. A low value here is the
   * signal to snap against the known-amounts list rather than trust the parse —
   * the OCR failure mode where 434 should have read £4.34.
   */
  readonly confidence?: number;
}

export interface BankFeed {
  readonly providerName: string;
  readonly source: BankFeedSource;

  listStatements(request: { readonly since?: number; readonly limit?: number }): Promise<readonly StatementSummary[]>;

  /**
   * Extract credits from one statement.
   *
   * T-5.8: OCR over a 104-page statement block is slow, so the activity wrapping
   * this heartbeats and resumes mid-batch rather than restarting from page 1
   * after a worker restart. `fromIndex` is what makes that resumption possible.
   */
  extractCredits(request: {
    readonly statementNumber: number;
    readonly fromIndex?: number;
  }): Promise<{ readonly credits: readonly BankCredit[]; readonly nextIndex?: number }>;
}
