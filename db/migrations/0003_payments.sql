-- 0003_payments — the four concurrent channels (functional spec §7, tech spec §4.2).

CREATE TYPE payment_method_type AS ENUM ('standing_order','direct_debit','card','agent_cash','giro');
CREATE TYPE payment_channel     AS ENUM ('so_fps','giro','branch_cash','card','direct_debit');
CREATE TYPE payment_status      AS ENUM ('allocated','unallocated','review','reversed');
CREATE TYPE subscription_status AS ENUM ('active','paused','failed','cancelled');
CREATE TYPE legacy_tier         AS ENUM ('weekly','deluxe','ambiguous','undetermined');

CREATE TABLE payment_method (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id     uuid NOT NULL REFERENCES member(id),
  type          payment_method_type NOT NULL,
  -- For a standing order this is the prize draw number the member quotes.
  reference     text,
  -- GAP-09: PSP undecided. A token, never card data — T-9.1 keeps PAN out of
  -- this system entirely via PSP-hosted fields or redirect.
  psp_token     text,
  -- GAP-10: Bacs route undecided, so the mandate lifecycle vocabulary is the
  -- provider's. Held as free text until the provider is chosen.
  mandate_ref    text,
  mandate_status text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT no_card_data_here CHECK (psp_token IS NULL OR psp_token !~ '^[0-9]{12,19}$')
);
COMMENT ON CONSTRAINT no_card_data_here ON payment_method IS
  'T-9.1: a bare PAN-shaped value in this column is a defect, not a token. Fail rather than store it.';

CREATE INDEX payment_method_member_idx ON payment_method (member_id) WHERE active;

CREATE TABLE subscription (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id          uuid NOT NULL REFERENCES member(id),
  payment_method_id  uuid REFERENCES payment_method(id),
  -- FR-2.5 / D10: store legacy amounts exactly as received. Never re-price.
  amount_pence       bigint NOT NULL,
  frequency          pay_frequency NOT NULL,
  annual_basis_pence bigint,
  basis_source       text,     -- 'register DD' | 'bank observed' | 'agent'
  legacy_tier        legacy_tier NOT NULL DEFAULT 'undetermined',
  status             subscription_status NOT NULL DEFAULT 'active',
  start_date         date NOT NULL DEFAULT CURRENT_DATE,
  end_date           date,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_member_idx ON subscription (member_id) WHERE status = 'active';

CREATE TABLE payment (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id             uuid REFERENCES member(id),
  agent_id              uuid REFERENCES agent(id),
  channel               payment_channel NOT NULL,
  received_date         date NOT NULL,
  amount_pence          bigint NOT NULL,
  source_reference      text,
  bank_transaction_id   uuid,
  -- FR-2.1: where allocation was inferred, record the confidence AND the evidence.
  allocation_confidence numeric(4,3) CHECK (allocation_confidence BETWEEN 0 AND 1),
  allocation_method     text,
  allocation_evidence   jsonb,
  -- FR-2.2: one payment covering several linked numbers, counted once as income.
  covers_member_numbers int[] NOT NULL DEFAULT '{}',
  -- T-8.2/T-8.3: derived deterministically from workflow state, never random.
  -- The unique index is the storage-layer half of the belt-and-braces guarantee.
  idempotency_key       text NOT NULL,
  status                payment_status NOT NULL DEFAULT 'unallocated',
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_has_a_payer CHECK (member_id IS NOT NULL OR agent_id IS NOT NULL OR status = 'unallocated')
);

CREATE UNIQUE INDEX payment_idempotency_key_uniq ON payment (idempotency_key);
CREATE INDEX payment_member_idx ON payment (member_id, received_date DESC);
CREATE INDEX payment_agent_idx  ON payment (agent_id, received_date DESC) WHERE agent_id IS NOT NULL;

CREATE TABLE agent_remittance (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id             uuid NOT NULL REFERENCES agent(id),
  period_key           text NOT NULL,
  received_date        date,
  amount_pence         bigint,
  bank_transaction_id  uuid,
  expected_total_pence bigint,
  variance_pence       bigint,
  status               text NOT NULL DEFAULT 'unreconciled'
                       CHECK (status IN ('matched','variance','unreconciled')),
  UNIQUE (agent_id, period_key)
);
