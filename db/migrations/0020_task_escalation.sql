-- 0020_task_escalation — every open human task gets an escalation workflow
-- (FR-5.6, GAP-42).
--
-- A process that blocks for a human may wait indefinitely (FR-5.4) only
-- because something stops the wait being forgotten. `EscalationWorkflow`
-- (packages/workflows/src/escalation.ts) is that something: one per open
-- task, started by the scheduled sweep, raising the task's escalation level
-- each time it goes overdue. The level is what the admin inbox shows and
-- sorts by.
--
-- GAP-42 ⛔ is still open — there is no escalation policy and no named
-- on-call — so escalating means making the task louder in the inbox and in
-- audit_log, not paging anybody. Who gets told, and how, is the decision.

ALTER TABLE human_task
  ADD COLUMN escalation_level       int NOT NULL DEFAULT 0 CHECK (escalation_level >= 0),
  ADD COLUMN last_escalated_at      timestamptz,
  -- Set once the sweep has started this task's EscalationWorkflow, so the
  -- sweep does not try again for every open task on every run.
  ADD COLUMN escalation_workflow_id text;

CREATE INDEX human_task_unescalated_idx ON human_task (opened_at)
  WHERE status = 'open' AND escalation_workflow_id IS NULL;
