/**
 * Draw randomness — GAP-21, resolved (client decision, 2026-08-30, see
 * docs/gap-register.md): draw from RANDOM.ORG's HTTP client interface.
 * `RANDOMNESS_SOURCE=random_org` is what puts that decision into effect; the
 * default remains `unset` until an operator sets it deliberately, and whether
 * independent assurance is ALSO required for the licensing authority's sign-off
 * is a residual question this decision did not cover.
 *
 * ⚠ T-6.1, described by the technical spec as "the single most important line in
 * this document":
 *
 *   The draw RNG must be an ACTIVITY, never workflow-deterministic randomness.
 *
 * Temporal offers a seeded random source that is stable across replay. Using it
 * for the draw would be catastrophic in a subtle way: the winning numbers would
 * become a deterministic function of workflow run identity, so anyone who could
 * observe or predict run identity could predict the draw — and a workflow reset
 * would reproduce the same numbers.
 *
 * Generating them in an activity records the RESULT in history, so replay
 * reproduces the recorded draw — the audit property NFR-1 requires — without the
 * numbers ever deriving from workflow state.
 *
 * Which entropy source is ACCEPTABLE is a licence-condition question for the
 * registering authority, not a technical preference. Hence the port.
 */
import type { Selection } from '@qosfc/domain';

export type RandomnessSourceKind =
  /** Node's CSPRNG. Defensible, but "defensible" is the regulator's word to say. */
  | 'csprng'
  /**
   * GAP-21, resolved (client decision): RANDOM.ORG's HTTP client interface
   * (https://www.random.org/clients/http/) — true randomness from atmospheric
   * noise, not a certified/signed service. See
   * packages/adapters-live/src/randomness/random-org.ts.
   */
  | 'random_org'
  /** A certified third-party draw service. */
  | 'external_certified'
  /** A physical draw, its result keyed in by an operator under dual control. */
  | 'manual_physical_draw';

/**
 * Everything needed to reproduce and defend the draw (FR-5.3.6): the source, the
 * seed, and whatever evidence that source can offer — a signature, a certificate,
 * an operator id, a video reference.
 */
export interface DrawEvidence {
  readonly source: RandomnessSourceKind;
  readonly seed: string;
  readonly generatedAt: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface DrawResult {
  readonly numbers: Selection;
  readonly evidence: DrawEvidence;
}

export interface RandomnessSource {
  readonly kind: RandomnessSourceKind;
  /**
   * @param drawId Recorded in the evidence so a result cannot be transplanted
   *               from one draw to another.
   */
  generateWinningNumbers(request: {
    readonly drawId: string;
    readonly poolN: number;
    readonly pickK: number;
  }): Promise<DrawResult>;
}
