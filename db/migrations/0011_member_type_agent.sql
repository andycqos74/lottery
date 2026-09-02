-- 0011_member_type_agent — distinguishing agent members from players.
--
-- Client decision, 2026-09-02: a physical/agent ticket (0010) is never
-- attributed to the actual player, who has no account and whom QOSFC cannot
-- identify or contact. It is attributed to the AGENT who sold it, so that if
-- it wins, notification goes through the normal member-notification workflow
-- (GAP-30) but reaches someone QOSFC can actually contact.
--
-- Deliberately NOT the same thing as the existing `agent` table
-- (db/migrations/0002): that is the legacy bulk-collection entity behind
-- `member_number.agent_id` and `agent_remittance` (GAP-19's unresolved bulk
-- lodgement problem — one agent, many players, no per-player breakdown).
-- `member.member_type = 'agent'` is a different, narrower thing: an agent who
-- ALSO has their own member record (their own contact details, their own
-- prize_draw_no), because for THIS flow QOSFC deliberately holds only the
-- agent as the identified party, not the player. The two concepts may turn
-- out to be the same people in practice; nothing here merges them.
CREATE TYPE member_type AS ENUM ('player', 'agent');
ALTER TABLE member ADD COLUMN member_type member_type NOT NULL DEFAULT 'player';

CREATE INDEX member_member_type_idx ON member (member_type) WHERE member_type = 'agent';
