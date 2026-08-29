/**
 * The gap mechanism.
 *
 * Functional spec FR-5.6: "Undecided rules become explicit pause points, never
 * invented defaults." Technical spec §15.2: "Never ship a suggested default as
 * final. Where a strategy interface has multiple implementations, the unselected
 * ones must fail explicitly, not fall through to the plausible-looking one."
 *
 * Every undecided rule in this codebase routes through here. Reaching one is not
 * a crash — it is the system correctly refusing to invent a rule about gambling
 * money. In a workflow, the caller catches it and opens a human_task instead.
 */

/** Gap identifiers, as registered in docs/gap-register.md. */
export type GapId = `GAP-${string}` | `TG-${string}`;

export class UnresolvedGapError extends Error {
  override readonly name = 'UnresolvedGapError';
  /** Marks this as non-retryable to Temporal: retrying cannot make a decision appear. */
  readonly nonRetryable = true;

  constructor(
    readonly gapId: GapId,
    readonly decisionNeeded: string,
    readonly whoDecides: string,
  ) {
    super(
      `${gapId} is unresolved: ${decisionNeeded}. This must be decided by ${whoDecides} ` +
        `and recorded in configuration — the system will not assume a value. ` +
        `See docs/gap-register.md.`,
    );
  }
}

/**
 * Halt on an undecided rule. Never returns.
 *
 * @example
 *   if (!cfg.mustBeWonMechanism) {
 *     unresolvedGap('GAP-24', 'the must-be-won mechanism at the £20,000 cap',
 *                   'the client, published to members before go-live');
 *   }
 */
export function unresolvedGap(gapId: GapId, decisionNeeded: string, whoDecides: string): never {
  throw new UnresolvedGapError(gapId, decisionNeeded, whoDecides);
}

/** True when an error is a gap halt, so callers can open a human_task rather than retry. */
export function isUnresolvedGap(e: unknown): e is UnresolvedGapError {
  return e instanceof Error && e.name === 'UnresolvedGapError';
}
