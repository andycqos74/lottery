/**
 * DrawWorkflow — P1 (functional §5.3, technical §5.1).
 *
 * The money arithmetic is deliberately in workflow code rather than an activity
 * (T-6.4): the allocation and jackpot calculation are the most audit-sensitive
 * logic in the system, and having them replayable and unit-testable without
 * infrastructure is worth more than the convenience of an activity.
 *
 * The RNG is deliberately NOT in workflow code (T-6.1). See activities/draw/rng.ts.
 */
import * as workflow from '@temporalio/workflow';
import {
  allocate,
  jackpotPosition,
  mustBeWonTriggered,
  revenueFor,
  pence,
  basisPoints,
  type Pence,
} from '@qosfc/domain';
import type { createActivities } from '@qosfc/activities';

const { openHumanTask, generateWinningNumbers, identifyWinners, settleDraw } = workflow.proxyActivities<
  ReturnType<typeof createActivities>
>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '1s', backoffCoefficient: 2, maximumAttempts: 5 },
});

/** GAP-24: the payout a human confirms until Phase 6 can compute it automatically. */
export interface MustBeWonDecision {
  readonly mechanism: string;
  readonly decidedBy: string;
  readonly secondApproverId: string;
  readonly note: string;
}

export const mustBeWonDecision = workflow.defineSignal<[MustBeWonDecision]>('must_be_won_decision');
export const getState = workflow.defineQuery<DrawState>('get_state');

export interface DrawState {
  readonly drawId: string;
  readonly status: 'open' | 'closed' | 'drawn' | 'settled' | 'blocked';
  readonly blockedOn?: string;
  readonly jackpotPreDrawPence?: string;
  readonly winnersCount?: number;
  readonly jackpotPaidPence?: string;
}

export interface DrawWorkflowInput {
  /** Identifiers only — T-1.3. Nothing here identifies a person. */
  readonly drawId: string;
  readonly drawNumber: number;
  readonly entriesCount: number;
}

export async function DrawWorkflow(input: DrawWorkflowInput): Promise<DrawState> {
  let state: DrawState = { drawId: input.drawId, status: 'closed' };
  workflow.setHandler(getState, () => state);

  let decision: MustBeWonDecision | undefined;
  workflow.setHandler(mustBeWonDecision, (d) => {
    decision = d;
  });

  // ── Pure, deterministic, replayable arithmetic (T-6.4) ──────────────────────
  const ticketPrice = pence(200);
  const split = {
    prizeBp: basisPoints(5000),
    goodCauseBp: basisPoints(4000),
    adminBp: basisPoints(1000),
  };
  const revenue = revenueFor(input.entriesCount, ticketPrice);
  const alloc = allocate(revenue, split);

  const rolloverIn: Pence = pence(0); // Phase 6: fetched by activity from the ledger
  const position = jackpotPosition(alloc.prizeContributionPence, rolloverIn, pence(50_000));

  // ── The RNG. An ACTIVITY, never workflow randomness (T-6.1) ─────────────────
  const drawn = await generateWinningNumbers({ drawId: input.drawId, poolN: 20, pickK: 4 });
  state = { ...state, status: 'drawn', jackpotPreDrawPence: position.jackpotPreDrawPence.toString() };

  const { winningEntries } = await identifyWinners({ drawId: input.drawId });
  const winnersCount = winningEntries.length;

  // ── GAP-24, resolved (roll down match 3 → 2 → 1, split equally — see
  // resolveMustBeWon in @qosfc/domain) — but identifyWinners only fetches
  // match-4 (exact selection) entries, not the match-3/2/1 tiers the
  // roll-down needs, and settleDraw only pays exact winners or rolls the
  // whole jackpot forward. Wiring resolveMustBeWon() into that path — extend
  // identifyWinners to also return the lower tiers (countMatches in
  // @qosfc/domain already does the matching), then have settleDraw call
  // resolveMustBeWon() and pay whichever tier it picks — is the next Phase 6
  // increment. Until then this still blocks for a human — not to decide the
  // mechanism (that's settled) but because nothing here can compute the tiers
  // to hand it (FR-5.3.5).
  if (mustBeWonTriggered(position.jackpotPreDrawPence, winnersCount, pence(2_000_000))) {
    await openHumanTask({
      kind: 'must_be_won_decision',
      title: `Draw ${input.drawNumber}: jackpot reached the £20,000 must-be-won cap with no winner`,
      detail:
        'D9 forces a win at £20,000. The roll-down mechanism is decided (match 3 → 2 → 1, split ' +
        'equally among winners in the winning tier), but this workflow cannot yet compute who is in ' +
        'which tier — Phase 6 does not exist. Record who should be paid and how much.',
      consequenceIfIgnored:
        'The draw stays blocked and no prize is paid until two authorised people record a decision. ' +
        'Nothing is lost — the entry set is frozen and the workflow resumes where it stopped.',
      gapId: 'GAP-24',
      entityType: 'draw',
      entityId: input.drawId,
      workflowId: workflow.workflowInfo().workflowId,
      runId: workflow.workflowInfo().runId,
      signalName: 'must_be_won_decision',
      // GAP-44: a single-person override on a potential £20,000 payout is not
      // defensible, so the quorum is a property of the workflow, not the UI.
      requiresSecondApprover: true,
      dedupeKey: `must_be_won:${input.drawId}`,
    });

    state = { ...state, status: 'blocked', blockedOn: 'GAP-24 must-be-won mechanism' };

    // No timeout that defaults. FR-5.4 permits an indefinite wait precisely for
    // processes parked pending a business decision (FR-5.6); the escalation
    // workflow attached to the task is what stops it being forgotten.
    await workflow.condition(() => decision !== undefined);

    if (!decision!.secondApproverId || decision!.secondApproverId === decision!.decidedBy) {
      throw workflow.ApplicationFailure.nonRetryable(
        'GAP-44: the must-be-won decision requires two distinct approvers.',
        'QuorumNotMet',
      );
    }
  }

  const settled = await settleDraw({
    drawId: input.drawId,
    winningEntries,
    jackpotPreDrawPence: position.jackpotPreDrawPence.toString(),
  });
  void drawn;
  // Entry-purchase-time revenue recognition (good cause / admin shares) is a
  // separate, unbuilt concern gated on GAP-09/10/27 — not part of settling a
  // draw's jackpot.
  void alloc;

  state = {
    ...state,
    status: 'settled',
    winnersCount: settled.winnersCount,
    jackpotPaidPence: settled.jackpotPaidPence,
  };
  return state;
}
