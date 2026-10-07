-- 0023_run_log — a plain-language log of every Temporal workflow run.
--
-- One row per finished run, written by `RunLogSweepWorkflow` from Temporal's
-- own record of the run (its status, and its result or failure) — never by
-- the workflows themselves, so a run that crashed, timed out or was
-- terminated is logged just like one that finished, and no workflow's
-- history had to change to add it. Shown on the admin console's Log page.
--
-- Messages are short and carry no personal data: counts, draw numbers,
-- amounts and task titles only.

CREATE TABLE run_log (
  id            bigserial PRIMARY KEY,
  workflow_type text NOT NULL,
  workflow_id   text NOT NULL,
  run_id        text NOT NULL,
  -- Temporal's execution status: COMPLETED, FAILED, TIMED_OUT, TERMINATED, CANCELLED.
  status        text NOT NULL,
  category      text NOT NULL CHECK (category IN ('success', 'info', 'error')),
  message       text NOT NULL,
  -- A routine run that found nothing to do (most schedule ticks). Hidden by
  -- default on the Log page, and pruned after 30 days.
  quiet         boolean NOT NULL DEFAULT false,
  started_at    timestamptz,
  closed_at     timestamptz NOT NULL,
  logged_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, run_id)
);

CREATE INDEX run_log_closed_idx ON run_log (closed_at DESC);
CREATE INDEX run_log_category_idx ON run_log (category, closed_at DESC) WHERE NOT quiet;
