/**
 * The Phase 1 gate workflow.
 *
 * Its only job is to prove that Workflow Update works end to end on the pinned
 * server version (T-10.8), because two things in this system are built on it:
 *
 *   - FR-3.3: a member changing their selection gets an immediate accept or
 *     reject, not a silent queued change.
 *   - T-4.1: a human task is marked resolved only once the workflow has ACCEPTED
 *     the decision, so a task and its workflow can never disagree about whether
 *     a decision was made. A signal is fire-and-forget and can disagree.
 *
 * Whether Updates need explicit enablement, and under which dynamic-config flag,
 * has changed across Temporal releases. This is a cheap check that is expensive
 * to discover late — hence a workflow whose whole purpose is to be verified.
 */
import * as workflow from '@temporalio/workflow';
import type { UpdateDefinition } from '@temporalio/common';
import { parseSelection, type Selection } from '@qosfc/domain';

export interface SelectionAccepted {
  readonly accepted: true;
  readonly selection: Selection;
}

// Explicitly annotated: without it TypeScript infers a type that names the
// pnpm-hoisted @temporalio/common path, which is not portable across installs.
export const setSelection: UpdateDefinition<SelectionAccepted, [number[]]> = workflow.defineUpdate<
  SelectionAccepted,
  [number[]]
>('setSelection');

export async function StackVerificationWorkflow(): Promise<Selection | undefined> {
  let current: Selection | undefined;

  workflow.setHandler(
    setSelection,
    (numbers) => {
      current = parseSelection(numbers).ok ? (parseSelection(numbers) as { selection: Selection }).selection : current;
      return { accepted: true as const, selection: current! };
    },
    {
      /**
       * The validator is what makes this an Update rather than a Signal: it runs
       * BEFORE the update is written to history and can reject, so the caller
       * gets a synchronous, specific "no" — which is exactly what FR-3.3 asks
       * for. A validator must be deterministic and must not mutate state.
       */
      validator: (numbers: number[]) => {
        const result = parseSelection(numbers);
        if (!result.ok) throw new Error(result.reason);
      },
    },
  );

  // Hold open so the verification script can exercise both paths, then terminate
  // it. Bounded, so a forgotten verification run cannot linger indefinitely.
  await workflow.condition(() => false, '2 minutes');
  return current;
}
