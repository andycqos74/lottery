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
  resolveMustBeWonRollDown,
  revenueFor,
  settleOutcome,
  pence,
  basisPoints,
  type MustBeWonEntry,
  type Pence,
} from '@qosfc/domain';
import type { createActivities } from '@qosfc/activities';

const { openHumanTask, generateWinningNumbers } = workflow.proxyActivities<ReturnType<typeof createActivities>>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '1s', backoffCoefficient: 2, maximumAttempts: 5 },
});

/** GAP-24: the decision a human supplies to unblock a capped, unwon draw. */
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

  const winnersCount = 0; // Phase 6: identify_winners activity over the frozen entry set
  // Phase 6: identify_winners also supplies this — every entry in the frozen set
  // with its selection, so the roll-down below can count matches per tier.
  const entries: readonly MustBeWonEntry[] = [];

  // ── GAP-24, resolved — roll down to match-3 / match-2 / match-1 in that
  // order, splitting the whole jackpot equally between winners (by member) in
  // whichever tier is reached. D4 excluded those tiers from the ordinary game;
  // this reintroduces them only as the must-be-won last resort. FR-5.3.5 still
  // applies to the one case no rule covers: nobody matching even one number.
  let rollDown: ReturnType<typeof resolveMustBeWonRollDown> = undefined;
  if (mustBeWonTriggered(position.jackpotPreDrawPence, winnersCount, pence(2_000_000))) {
    rollDown = resolveMustBeWonRollDown(entries, drawn.numbers, position.jackpotPreDrawPence);

    if (!rollDown) {
      await openHumanTask({
        kind: 'must_be_won_decision',
        title: `Draw ${input.drawNumber}: jackpot reached the £20,000 must-be-won cap with no winner at any tier`,
        detail:
          'GAP-24 is resolved for the ordinary case — roll down to match 3 / 2 / 1, split equally between ' +
          'winners in the tier reached — but nobody matched even one number, which the decision does not ' +
          'cover, so this must not be invented here.',
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

      state = { ...state, status: 'blocked', blockedOn: 'GAP-24 must-be-won: no match at any tier' };

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
  }

  const outcome = rollDown
    ? { jackpotPaidPence: position.jackpotPreDrawPence, rolloverOutPence: pence(0), winnersCount: rollDown.winningEntries.length }
    : settleOutcome(position.jackpotPreDrawPence, winnersCount);
  void outcome; // Phase 6: settle_draw writes draw, ledger and prizes (rollDown.shares when set) in one transaction
  void alloc;

  state = { ...state, status: 'settled' };
  return state;
}
