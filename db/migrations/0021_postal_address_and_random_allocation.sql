-- 0021_postal_address_and_random_allocation — GAP-05 and GAP-13.
--
-- GAP-05 (client decision, 2026-10-06): a member's postal address only
-- matters if they win and have no email address — then a
-- `winner_missing_email` task asks a person to contact them by post
-- (notifyWinners, packages/activities/src/draw/notify-winners.ts). The
-- address already has address_1, address_2, address_3 (the portal and admin
-- label it "Town") and post_code from 0002; county is the one UK postal
-- address part with nowhere to go. All optional.
--
-- GAP-13 (client decision, 2026-10-06): a line with no numbers chosen a week
-- after it was issued gets RANDOM.ORG numbers ('randomly_allocated'), and the
-- member is told by email, or by post through a task when there is no email
-- (packages/activities/src/entries/random-allocation.ts).

ALTER TABLE member ADD COLUMN county text;

COMMENT ON COLUMN member.address_3 IS 'Town / city.';
COMMENT ON COLUMN member.county IS 'Optional (GAP-05). Postal address: address_1, address_2, address_3 (town), county, post_code.';

-- When the number was issued — the final data load, for the legacy register.
-- GAP-13's week to choose numbers runs from here. Existing rows take the time
-- this migration runs, which is when their week starts.
ALTER TABLE member_number ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

-- Set once the member has been told their randomly allocated numbers — by an
-- accepted email, or by opening the task to post them. Until then the
-- allocation sweep keeps trying.
ALTER TABLE selection_standing ADD COLUMN allocation_notified_at timestamptz;

CREATE INDEX selection_standing_unnotified_allocation_idx ON selection_standing (created_at)
  WHERE source = 'randomly_allocated' AND allocation_notified_at IS NULL;
