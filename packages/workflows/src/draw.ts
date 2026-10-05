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

const {
  openHumanTask,
  generateDueEntries,
  closeDrawForRun,
  generateWinningNumbers,
  identifyWinners,
  countRollDownTiers,
  getRolloverIn,
  settleDraw,
  notifyWinners,
} = workflow.proxyActivities<
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
/** Sent when a human resolves the task raised because entries could not be generated. */
export const retryDraw = workflow.defineSignal('retry_draw');
export const getState = workflow.defineQuery<DrawState>('get_state');

export interface DrawState {
  readonly drawId: string;
  readonly status: 'open' | 'closed' | 'drawn' | 'settled' | 'blocked';
  readonly blockedOn?: string;
  readonly jackpotPreDrawPence?: string;
  readonly winnersCount?: number;
  readonly jackpotPaidPence?: string;
  readonly winnersNotified?: number;
  readonly winnersNotificationPending?: number;
  /** GAP-24: the roll-down tier that won the must-be-won jackpot. */
  readonly mustBeWonTier?: 3 | 2 | 1;
}

export interface DrawWorkflowInput {
  /** Identifiers only — T-1.3. Nothing here identifies a person. */
  readonly drawId: string;
  readonly drawNumber: number;
  /**
   * Only for runs started before the workflow froze its own entry set, when
   * the caller generated entries, closed the draw and passed the count in.
   * The workflow now does all three itself and ignores this.
   */
  readonly entriesCount?: number;
}

export async function DrawWorkflow(input: DrawWorkflowInput): Promise<DrawState> {
  let state: DrawState = { drawId: input.drawId, status: 'closed' };
  workflow.setHandler(getState, () => state);

  let decision: MustBeWonDecision | undefined;
  workflow.setHandler(mustBeWonDecision, (d) => {
    decision = d;
  });

  let retryRequested = false;
  workflow.setHandler(retryDraw, () => {
    retryRequested = true;
  });

  // ── Freeze the entry set (FR-5.3.3) ─────────────────────────────────────────
  // GitHub #9/#11: every Direct Debit member and every member with prepaid
  // weeks left is entered before the draw closes. This used to happen in the
  // admin request before the workflow started — outside any retry or record —
  // so a run whose start failed after entries were generated left no trace.
  // Patched so a run started the old way replays its original history.
  let entriesCount: number;
  if (workflow.patched('freeze-entries-in-workflow')) {
    state = { ...state, status: 'open' };
    for (;;) {
      try {
        await generateDueEntries({ drawId: input.drawId, actorLabel: 'system (draw run)' });
        break;
      } catch (error) {
        // e.g. GAP-17 not activated. Running anyway would silently leave paid-up
        // members out, so the draw waits for a human to fix the cause and retry.
        retryRequested = false;
        await openHumanTask({
          kind: 'draw_entries_failed',
          title: `Draw ${input.drawNumber}: entries could not be generated, so the draw has not run`,
          detail:
            'Before a draw closes, every Direct Debit member and every member with prepaid weeks left is ' +
            `entered automatically. That step failed: ${failureMessage(error)} Fix the cause, then resolve ` +
            'this task to try again.',
          consequenceIfIgnored:
            'The draw stays open and does not run. Nothing is lost — entries made so far are kept, and the ' +
            'draw runs as soon as this task is resolved and entries generate successfully.',
          entityType: 'draw',
          entityId: input.drawId,
          workflowId: workflow.workflowInfo().workflowId,
          runId: workflow.workflowInfo().runId,
          signalName: 'retry_draw',
          dedupeKey: `draw_entries_failed:${input.drawId}`,
        });
        state = { drawId: input.drawId, status: 'blocked', blockedOn: 'entry generation failed' };
        await workflow.condition(() => retryRequested);
        state = { drawId: input.drawId, status: 'open' };
      }
    }
    ({ entriesCount } = await closeDrawForRun({ drawId: input.drawId, workflowId: workflow.workflowInfo().workflowId }));
    state = { drawId: input.drawId, status: 'closed' };
  } else {
    entriesCount = input.entriesCount ?? 0;
  }

  // ── Pure, deterministic, replayable arithmetic (T-6.4) ──────────────────────
  const ticketPrice = pence(200);
  const split = {
    prizeBp: basisPoints(5000),
    goodCauseBp: basisPoints(4000),
    adminBp: basisPoints(1000),
  };
  const revenue = revenueFor(entriesCount, ticketPrice);
  const alloc = allocate(revenue, split);

  // GitHub #10: start from what the previous draw rolled forward. Patched so a
  // draw already in flight when this shipped replays its original history
  // (which started from zero) instead of failing on an unexpected activity.
  let rolloverIn: Pence = pence(0);
  if (workflow.patched('rollover-in-from-previous-draw')) {
    const previous = await getRolloverIn({ drawId: input.drawId });
    rolloverIn = pence(BigInt(previous.rolloverInPence));
  }
  const position = jackpotPosition(alloc.prizeContributionPence, rolloverIn, pence(50_000));

  // ── The RNG. An ACTIVITY, never workflow randomness (T-6.1) ─────────────────
  const drawn = await generateWinningNumbers({ drawId: input.drawId, poolN: 20, pickK: 4 });
  state = { ...state, status: 'drawn', jackpotPreDrawPence: position.jackpotPreDrawPence.toString() };

  const { winningEntries } = await identifyWinners({ drawId: input.drawId });
  const winnersCount = winningEntries.length;

  // ── GAP-24: the must-be-won cap (D9) with no match-4 winner ────────────────
  // The client's decision: roll down to match 3, then 2, then 1 — the first
  // tier with a winning entry pays, split equally per winner
  // (resolveMustBeWon in @qosfc/domain, applied inside settleDraw). Only the
  // residual case the decision did not cover — nobody matched even one
  // number — still blocks for a human (FR-5.3.5). Patched so a draw already
  // blocked on the old human decision replays into that same wait.
  let mustBeWonRollDown = false;
  if (mustBeWonTriggered(position.jackpotPreDrawPence, winnersCount, pence(2_000_000))) {
    if (workflow.patched('must-be-won-roll-down')) {
      const tiers = await countRollDownTiers({ drawId: input.drawId });
      if (tiers.match3 + tiers.match2 + tiers.match1 > 0) {
        mustBeWonRollDown = true;
      } else {
        await blockForMustBeWonDecision(
          'No entry matched even one of the drawn numbers, so the confirmed roll-down (match 3 → 2 → 1, ' +
            'split equally among winners in the winning tier) has no tier to pay. That case was not covered by ' +
            'the GAP-24 decision. Record who should be paid and how much.',
        );
      }
    } else {
      await blockForMustBeWonDecision(
        'D9 forces a win at £20,000. The roll-down mechanism is decided (match 3 → 2 → 1, split ' +
          'equally among winners in the winning tier), but this workflow cannot yet compute who is in ' +
          'which tier — Phase 6 does not exist. Record who should be paid and how much.',
      );
    }
  }

  async function blockForMustBeWonDecision(detail: string): Promise<void> {
    await openHumanTask({
      kind: 'must_be_won_decision',
      title: `Draw ${input.drawNumber}: jackpot reached the £20,000 must-be-won cap with no winner`,
      detail,
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
    rolloverInPence: position.rolloverInPence.toString(),
    floorTopupPence: position.floorTopupPence.toString(),
    ...(mustBeWonRollDown ? { mustBeWonRollDown: true } : {}),
  });
  void drawn;
  // Entry-purchase-time revenue recognition (good cause / admin shares) is a
  // separate, unbuilt concern gated on GAP-09/10/27 — not part of settling a
  // draw's jackpot.
  void alloc;

  // The money already moved in settleDraw above — a notification fault must
  // not fail settlement or leave the draw stuck. GAP-46 (retry/abandonment
  // policy) is unresolved, so a failure here is surfaced via get_state for an
  // operator to notice (winnersNotificationPending), not retried indefinitely
  // or silently dropped.
  let notifyResult: { notified: number; pending: number } | undefined;
  if (settled.winnersCount > 0) {
    try {
      notifyResult = await notifyWinners({ drawId: input.drawId, drawNumber: input.drawNumber });
    } catch (error) {
      workflow.log.error('notifyWinners failed; winning prize rows remain pending_notification', { error });
    }
  }

  state = {
    ...state,
    status: 'settled',
    winnersCount: settled.winnersCount,
    jackpotPaidPence: settled.jackpotPaidPence,
    ...(settled.mustBeWonTier ? { mustBeWonTier: settled.mustBeWonTier } : {}),
    ...(notifyResult ? { winnersNotified: notifyResult.notified, winnersNotificationPending: notifyResult.pending } : {}),
  };
  return state;
}

/** The readable reason inside an ActivityFailure — the treasurer reads this, not a stack trace. */
function failureMessage(error: unknown): string {
  const cause = error instanceof workflow.ActivityFailure ? error.cause : error;
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.endsWith('.') ? message : `${message}.`;
}
