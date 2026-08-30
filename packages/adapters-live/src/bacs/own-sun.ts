/**
 * GAP-10 — the Bacs route, STILL UNCONFIRMED. The client's working assumption
 * is submitting under the society's OWN Service User Number rather than
 * through a bureau or GoCardless, with the option to switch to a bureau later
 * kept open by staying behind this port.
 *
 * Every method refuses explicitly (matching `ExternalCertifiedRandomnessSource`
 * elsewhere in this codebase) rather than pretending to work. This is
 * deliberate, not a shortcut: a real "own SUN" submission is a Bacs Standard 18
 * file over Bacstel-IP, with its own record layout, checksums and test-service
 * accreditation. Hand-rolling a plausible-looking but wrong S18 file would be
 * worse than this — it is a financial instruction to a bank, and "looks right"
 * is not a bar that matters there. That work starts once GAP-10 is confirmed
 * and the client has Bacstel-IP access to build and test against for real.
 *
 * `settlementDays` is set to match the sandbox default; own-SUN submission
 * windows may differ once real cut-off times are known.
 */
import type {
  BacsBureau,
  CollectionInstruction,
  CollectionResult,
  IdempotencyKey,
  Mandate,
  MandateEvent,
  MandateRequest,
  SubmissionReceipt,
} from '@qosfc/ports';

const PROVIDER = 'live:bacs-own-sun';

function notConfirmed(method: string): never {
  throw new Error(
    `GAP-10: ${PROVIDER}.${method}() has no Bacstel-IP integration to call yet — own-SUN submission ` +
      'needs the client to hold a Service User Number and Bacstel-IP access before a real Standard 18 ' +
      'file can be built and tested. Confirm GAP-10, then implement this against that access; the port ' +
      'and the rest of the Direct Debit workflow do not change.',
  );
}

export class OwnSunBacsBureau implements BacsBureau {
  readonly providerName = PROVIDER;
  readonly settlementDays = 3;

  async createMandate(_request: MandateRequest): Promise<Mandate> {
    notConfirmed('createMandate');
  }

  async getMandate(_mandateRef: string): Promise<Mandate> {
    notConfirmed('getMandate');
  }

  async submitCollections(_request: {
    readonly idempotencyKey: IdempotencyKey;
    readonly cycleKey: string;
    readonly instructions: readonly CollectionInstruction[];
  }): Promise<SubmissionReceipt> {
    notConfirmed('submitCollections');
  }

  async fetchCollectionResults(
    _submissionId: string,
  ): Promise<{ readonly ready: false } | { readonly ready: true; readonly results: readonly CollectionResult[] }> {
    notConfirmed('fetchCollectionResults');
  }

  async fetchMandateEvents(_since: string): Promise<readonly MandateEvent[]> {
    notConfirmed('fetchMandateEvents');
  }
}
