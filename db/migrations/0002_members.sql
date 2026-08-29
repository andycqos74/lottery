-- 0002_members — the register (functional spec §6, tech spec §4.1).
--
-- GAP-06 resolved this session to PERSON-as-member: one `member` row is a person
-- who may hold many legacy prize draw numbers. FR-1.3 requires the legacy number
-- to survive permanently and immutably, because it is quoted on standing order
-- mandates and QOSFC cannot change it.

CREATE TYPE member_status AS ENUM
  ('active','lapsed','cancelled','deceased','self_excluded','quarantined');
CREATE TYPE contact_channel AS ENUM ('post','email','phone','via_agent');
CREATE TYPE legacy_channel AS ENUM ('direct_bank','agent_collected','unknown');
CREATE TYPE pay_frequency AS ENUM ('weekly','fortnightly','monthly','quarterly','6monthly','annual');

CREATE TABLE member (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status            member_status NOT NULL DEFAULT 'active',
  title             text,
  forename          text,
  surname           text,
  address_1         text, address_2 text, address_3 text,
  post_code         text,
  post_code_valid   boolean NOT NULL DEFAULT false,   -- FR-12.2
  telephone         text,
  -- GAP-05 ⛔: no email address exists anywhere in the legacy register. Nullable
  -- is a statement of fact about the source data, not an optional field.
  email             citext,
  preferred_contact contact_channel NOT NULL DEFAULT 'post',  -- FR-1.5
  joining_date      date,
  date_of_birth     date,                             -- GAP-37: capture method undecided
  notes             text,
  -- Migration provenance (T-11.2).
  migrated_from_row int,
  source_file_hash  text,
  verify_flags      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The live P2 instance, 'member-<uuid>'.
  workflow_id       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- FR-11.2: minimum age 18. Enforced here as well as in the onboarding flow so
  -- a direct insert cannot bypass it. NULL is permitted because the legacy
  -- register holds no dates of birth (GAP-37 covers how they will be obtained).
  CONSTRAINT member_is_adult
    CHECK (date_of_birth IS NULL OR date_of_birth <= CURRENT_DATE - INTERVAL '18 years')
);

CREATE INDEX member_surname_idx ON member (lower(surname));
CREATE INDEX member_status_idx  ON member (status);
CREATE INDEX member_post_code_idx ON member (upper(replace(post_code, ' ', '')));

CREATE TABLE agent (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name     text NOT NULL UNIQUE,
  contact  jsonb NOT NULL DEFAULT '{}'::jsonb,
  active   boolean NOT NULL DEFAULT true
);

-- FR-1.3: the immutable legacy identifier. 3,774 rows migrate here — 1,591
-- members and 2,183 BLANK RESERVED placeholders which are numbers, not people
-- (FR-15.2), hence the nullable member_id.
CREATE TABLE member_number (
  prize_draw_no     int PRIMARY KEY,
  member_id         uuid REFERENCES member(id) ON DELETE RESTRICT,
  row_type          text NOT NULL CHECK (row_type IN ('member','blank_reserved')),
  -- FR-1.2: numbers covered by one payment, so income counts once per payment.
  linked_group_id   uuid,
  agent_id          uuid REFERENCES agent(id),
  legacy_agent      text,
  legacy_channel    legacy_channel NOT NULL DEFAULT 'unknown',
  -- T-11.2 / GAP-41: keep the raw string verbatim. £8.68 is NOT normalised to
  -- £8.64 — whether that is a historical variant or a data error is unrecorded.
  legacy_payment_raw text,
  legacy_amount_pence bigint,
  legacy_frequency  pay_frequency,
  legacy_status_text text,
  legacy_info       text,
  migrated_from_row int,

  CONSTRAINT blank_reserved_has_no_member
    CHECK ((row_type = 'blank_reserved' AND member_id IS NULL) OR row_type = 'member')
);

CREATE INDEX member_number_member_idx ON member_number (member_id);
CREATE INDEX member_number_linked_idx ON member_number (linked_group_id) WHERE linked_group_id IS NOT NULL;
CREATE INDEX member_number_agent_idx  ON member_number (agent_id) WHERE agent_id IS NOT NULL;

COMMENT ON COLUMN member_number.prize_draw_no IS
  'Legacy identifier quoted on standing order mandates. Immutable — QOSFC cannot change it (FR-1.3).';

-- FR-2.3 / FR-5.9: agents lodge one bulk sum; the expected member breakdown is
-- held separately purely as a control total. It is never bank-matched per member.
CREATE TABLE agent_member (
  agent_id              uuid NOT NULL REFERENCES agent(id),
  prize_draw_no         int  NOT NULL REFERENCES member_number(prize_draw_no),
  expected_amount_pence bigint,
  frequency             pay_frequency,
  PRIMARY KEY (agent_id, prize_draw_no)
);
