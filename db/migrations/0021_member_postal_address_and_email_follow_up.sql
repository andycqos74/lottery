-- 0021_member_postal_address_and_email_follow_up — GAP-05.
--
-- GAP-05 (client decision, 2026-10-06): some email addresses will be
-- populated on the final data load; for every member still without one, the
-- system opens a `member_missing_email` task for manual follow-up (the
-- `member-contact-follow-up` Schedule, packages/workflows/src/contact-follow-up.ts),
-- and a member's postal address must be recordable so they can be reached by
-- post meanwhile.
--
-- The address already has address_1, address_2, address_3 (the portal and
-- admin label it "Town") and post_code from 0002. County is the one UK postal
-- address part with nowhere to go. All optional: the legacy register is
-- incomplete, and a missing address is itself what the follow-up task is for.

ALTER TABLE member ADD COLUMN county text;

COMMENT ON COLUMN member.address_3 IS 'Town / city.';
COMMENT ON COLUMN member.county IS 'Optional (GAP-05). Postal address: address_1, address_2, address_3 (town), county, post_code.';

-- The follow-up sweep's question: live members with no email address.
CREATE INDEX member_missing_email_idx ON member (created_at)
  WHERE email IS NULL AND status IN ('active', 'lapsed');
