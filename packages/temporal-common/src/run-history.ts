/**
 * Temporal's record of finished workflow runs, for the run log (the admin
 * console's Log page). Implements `RunHistory` from @qosfc/activities by
 * shape, so this package needs no dependency on it.
 *
 * Results and failures come back through the client's data converter, so
 * with the encryption codec configured they are decrypted here, inside the
 * worker — the log only ever stores the short sentence built from them.
 */
import { WorkflowFailedError, type Client } from '@temporalio/client';

export interface FinishedRunRecord {
  readonly workflowType: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly status: string;
  readonly startedAt: Date | null;
  readonly closedAt: Date;
}

export function temporalRunHistory(client: Client) {
  return {
    async listFinishedRuns(since: Date, limit: number): Promise<FinishedRunRecord[]> {
      const runs: FinishedRunRecord[] = [];
      const query = `ExecutionStatus != "Running" AND CloseTime >= "${since.toISOString()}"`;
      for await (const info of client.workflow.list({ query })) {
        if (!info.closeTime) continue;
        runs.push({
          workflowType: info.type,
          workflowId: info.workflowId,
          runId: info.runId,
          status: info.status.name,
          startedAt: info.startTime ?? null,
          closedAt: info.closeTime,
        });
        if (runs.length >= limit * 2) break;
      }
      // Visibility lists newest first; log oldest first so a partial run leaves no gap behind it.
      return runs.sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime()).slice(0, limit);
    },

    async outcome(run: FinishedRunRecord): Promise<{ result: unknown } | { failure: string }> {
      const handle = client.workflow.getHandle(run.workflowId, run.runId, { followRuns: false });
      try {
        return { result: await handle.result() };
      } catch (error) {
        if (error instanceof WorkflowFailedError) {
          const cause = error.cause as { message?: string; cause?: { message?: string } } | undefined;
          return { failure: cause?.cause?.message ?? cause?.message ?? error.message };
        }
        return { failure: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
