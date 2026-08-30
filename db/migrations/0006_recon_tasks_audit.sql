-- 0006_recon_tasks_audit — bank reconciliation, the human task inbox, and the
-- audit log (functional spec §5.8/§12, tech spec §4.4/§4.5).

CREATE TYPE bank_source AS ENUM ('open_banking','csv','ocr_pdf');   -- GAP-33
CREATE TYPE bank_match_status AS ENUM ('matched','ambiguous','unmatched','agent_bulk');
CREATE TYPE match_decision AS ENUM ('auto_accepted','pending_review','accepted','rejected');
CREATE TYPE task_status AS ENUM ('open','resolved','expired','cancelled');

CREATE TABLE bank_statement (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_number       int NOT NULL UNIQUE,
  period_start           date NOT NULL,
  period_end             date NOT NULL,
  opening_balance_pence  bigint NOT NULL,
  closing_balance_pence  bigint NOT NULL,
  source                 bank_source NOT NULL,
  -- FR-5.8.2: continuity is verified BEFORE extraction. A break halts the batch
  -- rather than producing a partial reconciliation that looks complete.
  chain_verified         boolean NOT NULL DEFAULT false,
  -- T-9.5: object store key, never the bytes. Statement scans are personal data
  -- and large; neither belongs in a workflow payload or a database column.
  source_ref             text NOT NULL,
  ingested_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bank_transaction (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id         uuid NOT NULL REFERENCES bank_statement(id),
  value_date           date NOT NULL,
  description          text,
  type_raw             text,          -- 'Transfer','Standing Order','Giro','Branch'
  channel              payment_channel,
  amount_pence         bigint NOT NULL,
  is_credit            boolean NOT NULL,
  extracted_reference  text,
  extracted_name       text,
  -- T-5.7: OCR drops decimal points (434 -> £4.34). A low confidence here is a
  -- signal to snap against the known-amounts list, not to trust the raw parse.
  ocr_confidence       numeric(4,3),
  match_status         bank_match_status NOT NULL DEFAULT 'unmatched',
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bank_transaction_statement_idx ON bank_transaction (statement_id);
CREATE INDEX bank_transaction_unmatched_idx ON bank_transaction (match_status)
  WHERE match_status IN ('unmatched','ambiguous');

CREATE TABLE match_candidate (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_transaction_id uuid NOT NULL REFERENCES bank_transaction(id),
  prize_draw_no       int  NOT NULL REFERENCES member_number(prize_draw_no),
  confidence          numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  -- FR-5.8.3: the evidence breakdown is what turns a sub-threshold match into an
  -- identity question — "which member is this?" — rather than an amount conflict.
  evidence            jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision            match_decision NOT NULL DEFAULT 'pending_review',
  decided_by          uuid,
  decided_at          timestamptz,
  UNIQUE (bank_transaction_id, prize_draw_no)
);

-- ---------------------------------------------------------------------------
-- The human task inbox (tech spec §4.5, GAP-43).
--
-- Deliberately a database table rendered by the admin console, NOT the Temporal
-- Web UI. A volunteer treasurer must never be asked to send a raw signal from a
-- developer tool in order to release a stuck prize payment.
-- ---------------------------------------------------------------------------
CREATE TABLE human_task (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL,
  -- Business-language summary. FR-5.3: what it is waiting for, since when, what
  -- happens if nobody responds, and who may respond. Nothing waits silently.
  title          text NOT NULL,
  detail         text NOT NULL DEFAULT '',
  consequence_if_ignored text NOT NULL DEFAULT '',
  gap_id         text,             -- when the task exists because a rule is undecided
  entity_type    text,
  entity_id      uuid,
  -- The blocked process, and how to unblock it (T-4.1).
  workflow_id    text,
  run_id         text,
  signal_name    text,
  update_name    text,
  payload_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  opened_at      timestamptz NOT NULL DEFAULT now(),
  due_at         timestamptz,
  status         task_status NOT NULL DEFAULT 'open',
  resolved_by    uuid,
  resolved_at    timestamptz,
  resolution     jsonb,
  -- GAP-44: a single-person override on a gambling payout is not defensible.
  -- The quorum is enforced by the workflow (see packages/workflows), not by the UI.
  requires_second_approver boolean NOT NULL DEFAULT false,
  first_approver_id  uuid,
  second_approver_id uuid,
  -- Idempotency: one open task per (kind, entity), so a retried activity does not
  -- flood the treasurer's inbox with duplicates of the same decision.
  dedupe_key     text NOT NULL,

  CONSTRAINT approvers_must_be_different
    CHECK (second_approver_id IS NULL OR second_approver_id <> first_approver_id),
  CONSTRAINT resolved_tasks_record_who
    CHECK (status <> 'resolved' OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX human_task_open_dedupe_uniq ON human_task (dedupe_key) WHERE status = 'open';
CREATE INDEX human_task_open_idx ON human_task (opened_at) WHERE status = 'open';
CREATE INDEX human_task_due_idx  ON human_task (due_at) WHERE status = 'open' AND due_at IS NOT NULL;

COMMENT ON CONSTRAINT approvers_must_be_different ON human_task IS
  'GAP-44: two distinct humans, enforced by the database as well as the workflow.';

-- FR-13.1: append-only. Who, what, before/after, when — including every human
-- decision that unblocked a process, every retry, and every compensation.
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid,
  actor_label text NOT NULL DEFAULT 'system',
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  workflow_id text,
  run_id      text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id, at DESC);
CREATE INDEX audit_log_at_idx     ON audit_log (at DESC);

-- Admin identities (T-9.3): individual named accounts with MFA. No shared logins.
CREATE TABLE app_user (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE,
  display_name   text NOT NULL,
  password_hash  text NOT NULL,            -- argon2id
  totp_secret_enc bytea,                   -- encrypted at rest; MFA mandatory for admins
  mfa_enrolled   boolean NOT NULL DEFAULT false,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

-- GAP-03: the permission matrix is undefined, so roles are DATA, not code, and
-- every privileged action defaults to deny until the matrix is supplied.
CREATE TABLE app_role (
  name        text PRIMARY KEY,
  description text NOT NULL,
  permissions text[] NOT NULL DEFAULT '{}'
);
CREATE TABLE app_user_role (
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role    text NOT NULL REFERENCES app_role(name),
  PRIMARY KEY (user_id, role)
);
