# Switch-over dry run — from empty to "Draw 1 ready"

**Purpose.** Rehearse, end to end, how the live lottery will be set up: start
from an empty system and finish with the legacy register loaded, agents set
up, every standing-order member's money matched to entries, and the first
draw open and ready to go live. Every step is timed and every manual action
written down, so go-live runs from this document rather than from memory.

**Out of scope.** Agent-collected entries (physical tickets keyed against
agents, GAP-19 option c). The agents are *created* here; their players'
tickets are processed after go-live and are not needed for the dry run.
Running Draw 1 is also optional (Phase 10).

Sources this plan is built from: `docs/SETUP.md` (§2, §2.2, §2.2.1, §2.2.2,
§2.3), `docs/gap-register.md`, the register importer
(`packages/domain/src/legacy-register.ts`,
`packages/activities/src/migration/import-legacy-register.ts`), bank matching
(`packages/activities/src/reconcile/match-transactions.ts`), entry allocation
(`packages/activities/src/draw/allocate-upcoming.ts`) and random allocation
(`packages/activities/src/entries/random-allocation.ts`), as of `ed43e7b`.

---

## 1. How a standing-order member ends up entered in Draw 1

This is the chain the dry run has to prove. Each link is a separate step, and
a member missing any link is **not entered**:

```
register row (PAYING, bank-paid, amount + frequency)
  └─ load ─────────────► member + member_number + standing_order payment_method + subscription
                          (no numbers chosen, no entries, no credit)
numbers ───────────────► the member picks them on the portal, OR, 7 days after
                          the load, RANDOM.ORG allocates them (GAP-13 sweep)
                          → a "line" (selection_standing) exists
money ─────────────────► a bank statement credit quoting the prize draw number
                          is matched (review task, or auto-accept if TG-04 set)
                          → payment, channel so_fps; weeks = total ÷ £2
entry ─────────────────► allocateUpcomingEntries() places one week per open
                          draw, soonest first, until the weeks run out
```

Three consequences shape the whole plan:

1. **The load creates no entries and no credit.** A standing order only
   becomes entries when money that arrived at the bank is matched. Until then
   it appears only as the jackpot estimate ("+ N standing orders (est.)").
2. **No numbers, no entry.** Money matched to a number with no line waits.
   Legacy members have no numbers on load, so the GAP-13 week
   (`RANDOM_ALLOCATION_GRACE_DAYS = 7`, a constant) plus the hourly sweep
   (200 lines per run) must finish **before Draw 1's entries close**.
3. **Weeks paid before the cut-over need an opening credit.** A member whose
   standing order is monthly, quarterly or annual has usually paid, before
   the cut-over, for weeks the old lottery never drew. That money is on the
   old statements, not the new ones, so it is carried over once with
   `pnpm opening-credit` (D2 (c), SETUP §2.2.3, Phase 8 step 5). Without it
   they have no entries until their next payment arrives.

---

## 2. Decisions needed before the dry run

| # | Decision | Recommendation for the dry run | Who |
|---|---|---|---|
| D1 | **Real or anonymised data, and where.** B-2 says real member data stays off dev machines; the dev stack sends real email (`NOTIFIER=socketlabs`). | Run on the dev host with the **real register and statement**, *but* with `NOTIFIER=sandbox` (mail goes to mailpit), and delete the files after. Or anonymise the names/emails/addresses (keep Prize Draw No, amounts, frequencies, status, channel, agent). Either way, no real member may get an email from the dry run. | Andy |
| D2 | **Legacy prepaid credit.** How does a member who paid their monthly/quarterly/annual standing order *before* cut-over get entries in the first draws? Options: (a) nothing — entries start from their next payment; (b) import a longer statement window so earlier payments count as weeks (risks paying twice for weeks the old lottery already drew); (c) a one-off opening credit per number, calculated from the old statements up to the cut-off — **built**: `pnpm opening-credit` (SETUP §2.2.3). It runs a balance per number (payments in, £2 out for each old weekly draw) and credits the whole weeks left at the cut-off, so nobody gets weeks the old lottery already drew. | Run (c) in Phase 8 step 5 and compare the Phase 9 "no Draw 1 entry" count with and without it. | Andy / treasurer |
| D3 | **Cut-over date and statement window.** The *cut-off* is the old lottery's last draw; the first day whose standing-order credits belong to the new lottery is the day after. Also: the old lottery's draw weekday. | Use the old lottery's last draw as `--cutoff` (Phase 8 step 5) and upload statements on the Bank statements page from the day after. | Andy |
| D4 | **First draw date and the series.** GAP-16: Fridays 12:00, entries close Friday 00:00. | Create a weekly series of 13 draws from the intended live Draw 1 date, so quarterly payments place in full (weeks beyond created draws wait — rule 4). | Andy |
| D5 | **TG-04 auto-accept threshold.** Unset = every credit is a manual review task (likely 600–800 for a month). A credit that quotes one number and equals that number's subscription amount scores 0.9. | Set it to `0.9` for the dry run so exact matches allocate themselves and only the odd ones need review. Record the confirmer. | Andy |
| D6 | **GAP-35 quarantine list.** Defaults: #1304 and Alan Henry's rows. | Use the defaults unless the queries are resolved. | Andy |
| D7 | **Expected counts** for the GAP-40 check (`--expect-rows/--expect-members/--expect-blank`). SETUP uses 3774 / 1591 / 2183 for the earlier file. | Recount from the final spreadsheet before loading. | Andy |

---

## 3. Data requirements

| # | Data | Format / content | Expected source | Needed at |
|---|---|---|---|---|
| R1 | **Legacy register** (final version) | CSV or TSV, header row first: `Prize Draw No`, `Title`, `Forename`, `Surname`, `Address 1`–`3`, `Post Code`, `Telephone`, `Agent`, `Channel`, `Joining Date`, `Payment Type (raw)`, `Amount (parsed)`, `Frequency (parsed)`, `Info`, `Row Type`, `Status`, `Payments (12m)`, `Total (12m)`, `Observed Freq`, optional `Email` (SETUP §2.2.2) | The cleaned register spreadsheet (`Lottery_Database_Cleaned_2026.xlsx` lineage, with the Email column added per GAP-05, 2026-10-27), saved as CSV by Andy. Not in the repo (B-1). | Phase 4 |
| R2 | **Expected counts** for R1 | total rows, member rows, BLANK RESERVED rows | Counted from R1 by Andy (D7) | Phase 4 |
| R3 | **Bank statement(s)** for the cut-over window | The bank's own "TransactionHistory" CSV export (the format `real-export-csv-format.ts` maps, B-10); credits must quote the prize draw number in the reference | Club bank account online-banking export, by the treasurer, covering D3's date to the dry-run date | Phase 8 |
| R3a | **Old-lottery bank statements** for the opening credit | Same export format, covering the **12 months up to the cut-off** (annual payers' last payment must be in it); several overlapping files are fine | Same account, by the treasurer; can be the same exports the register's `Payments (12m)` columns were worked out from | Phase 8 step 5 |
| R4 | **Agent list** | Name, telephone, email (if any), postal address for each agent | Distinct values of the register's `Agent` column (query in Phase 5) for the names; contact details from the lottery organiser / club records | Phase 3 |
| R5 | **Admin users** | Name and email for at least two people (GAP-44 needs two different approvers) | Andy + a second officer (treasurer) | Phase 2 |
| R6 | **Draw schedule** | First draw date, number of draws, draw time, cutoff | D4 / GAP-16 | Phase 6 |
| R7 | **Config decisions** with named confirmers | GAP-17 prepaid blocks, GAP-22/23 share policy, GAP-21 RANDOM.ORG, GAP-16 day/time/cutoff, TG-04 threshold | Recorded decisions in `gap-register.md` (Andy Cowan, 2026-08-30 / 10-01 / 10-06), D5 | Phase 2 |
| R8 | **Provider credentials** | SocketLabs server id + API key; Elavon merchant alias + secret key (sandbox for dry run) | Already in `deploy/secrets/` on the dev host; live ones from SocketLabs / Elavon for go-live | Phase 2 |

Not needed for the dry run: agents' players' tickets and pay-ins, Direct
Debit mandates (none exist for legacy members, GAP-04), card purchases.

---

## 4. Ground rules for the run

- Keep a **run log**: start/end time of every step, who did it, anything
  typed or clicked that is not in this document, and every surprise.
- Steps marked **[DRY RUN ONLY]** are shortcuts that do not happen live
  (backdating, mail routing). Everything else should be done exactly as it
  will be on the live VPS.
- Use the admin console wherever a step has one — the point is to prove what
  the treasurer will actually do — and the shell only where there is no
  console route.
- Do not use `docker-compose.dev-no-mfa.yml` for the dry run: log in with
  MFA, as live will.

Commands assume the dev stack: compose project `qosfc-lottery`, run from
`/root/lottery/deploy/compose`, with the file list from the dev-stack notes:

```bash
cd /root/lottery/deploy/compose
set -a; . ./images.env; set +a            # never source ../.env
DC="docker compose -p qosfc-lottery --env-file ../.env \
  -f docker-compose.core.yml -f docker-compose.app.yml -f docker-compose.sandbox.yml \
  -f docker-compose.dev-ports.yml -f docker-compose.dev-ports.tailscale.yml"
OWNER="postgres://lottery_owner@localhost:5432/lottery_app"
```

---

## 5. The runbook

### Phase 0 — Prepare (day before)

1. Collect R1–R8 and answer D1–D7. Put R1 and R3 **outside the repository**
   (e.g. `/root/switchover-dryrun/`), mode 600.
2. Make sure the dev checkout is on current `main` and images are built from
   it (the dev checkout is behind `origin/main`: `git pull`, rebuild).
3. Note what the current `deploy/.env` holds so it can be put back after.

### Phase 1 — Clear all data

The dev wipe script (`tools/dev/seed-test-draws.ts`) keeps members, logins,
config and the audit log, so it is not enough. Clear everything by recreating
both databases — this is also exactly what the live VPS starts from.

1. Back up what is there now:
   ```bash
   docker exec qosfc-lottery-postgres-app-1 pg_dump -U lottery_owner -Fc lottery_app \
     > /root/qosfc-dev-backups/lottery_app-pre-dryrun-$(date +%Y%m%d).dump
   ```
2. Stop everything and remove the volumes (app DB, Temporal DB, uploaded
   statements, mailpit):
   ```bash
   $DC down -v
   docker volume ls | grep qosfc-lottery     # expect none left
   ```
3. Bring up the datastores and Temporal, then bootstrap (SETUP §2 steps 4–6):
   ```bash
   $DC up -d postgres-app postgres-temporal temporal
   cd /root/lottery && ./deploy/bootstrap/bootstrap-temporal.sh
   ./deploy/bootstrap/bootstrap-app-db.sh
   ```
4. **Check:** `pnpm verify:stack` passes; `member`, `draw`, `config_version`,
   `app_user` are all empty.

Secrets in `deploy/secrets/` are kept for the dry run. **Live:** they are
generated fresh on the VPS (`generate-secrets.sh`), and the codec key is
backed up off the machine (SETUP §4.1).

### Phase 2 — Manual configuration

1. **`deploy/.env`** — set before starting the app containers:

   | Variable | Dry run | Live |
   |---|---|---|
   | `NODE_ENV` | `development` | `production` |
   | `NOTIFIER` | **`sandbox`** (D1) — mail to mailpit **[DRY RUN ONLY]** | `socketlabs` |
   | `RANDOMNESS_SOURCE` | `random_org` (GAP-13 refuses anything else) | `random_org` |
   | `BANK_FEED` | `csv` | `csv` |
   | `PAYMENT_GATEWAY` | `elavon`, `ELAVON_ENVIRONMENT=sandbox` | `elavon`, `production`, live alias + key |
   | `BACS_BUREAU` | `sandbox` | no working live option yet (GAP-10) — see G5 in §7 |
   | `TEMPORAL_SCHEDULES` | `on` | `on` |
   | hostnames / `ADMIN_ALLOWED_CIDRS` | dev values | live DNS + club CIDRs |

2. Start the app: `$DC up -d`. **Check:** in the Temporal UI the schedules
   `draw-dispatch`, `task-escalation-sweep`, `selection-random-allocation`,
   `direct-debit` and `run-log` exist.
3. **Admin users** (R5), from the repo root, one per person:
   ```bash
   ADMIN_EMAIL=… ADMIN_NAME="…" pnpm create:admin-user
   ```
   Each person enrols the TOTP key in an authenticator and logs in once.
4. **Config** (R7) — one `activate-config` call, then the two columns the CLI
   cannot set yet, by SQL as the owner role:
   ```bash
   ENTRY_STRATEGY=prepaid_blocks ENTRY_STRATEGY_CONFIRMED_BY="Andy Cowan, 2026-08-30" \
   SHARE_BASIS=per_winning_entry SHARE_REMAINDER_RULE=to_good_cause \
   SHARE_POLICY_CONFIRMED_BY="Andy Cowan, 2026-08-30" \
   RNG_SOURCE=random_org RNG_SOURCE_CONFIRMED_BY="Andy Cowan, 2026-08-30" \
   DRAW_DAY_OF_WEEK=5 DRAW_TIME_LOCAL=12:00 \
   NOTE="Switch-over dry run: GAP-16/17/21/22/23" pnpm activate-config
   ```
   ```sql
   -- selection_cutoff_before (GAP-16) and recon_auto_threshold (TG-04, D5)
   -- are not settable through activate-config. Versioned config is
   -- insert-only in spirit, so do this before any draw exists.
   UPDATE config_version SET selection_cutoff_before = interval '12 hours',
                             recon_auto_threshold = 0.900
    WHERE is_active;
   ```
   **Check:** `SELECT * FROM config_version WHERE is_active` shows every
   value above with its confirmer.

### Phase 3 — Agents

1. Find the agent names — after Phase 4 the register gives them; before it,
   use R4:
   ```sql
   SELECT legacy_agent, count(*) FROM member_number
    WHERE legacy_channel = 'agent_collected' GROUP BY 1 ORDER BY 2 DESC;
   ```
2. For each agent: admin console → **Members** → add member, Type
   **Agent**; then on the member page enter telephone, email, address and
   preferred contact.
3. **Check:** the count of agent-type members equals the agent list; each
   appears in a draw's *Record a physical/agent ticket* dropdown (Phase 6).
   Do not record any tickets.

Agents can be created before or after the register load; doing it after
lets the names be taken from the loaded data.

### Phase 4 — Load the legacy register

Admin console → **Members** → *Load the legacy register from the
spreadsheet* (`/legacy-register`), SETUP §2.2.2.

1. Choose R1, enter R2's counts, **Check register**.
2. Read the summary, the values seen in each deciding column, and download
   the exceptions CSV. Expect: rejected repeats 1253/1515/2498 (GAP-07);
   `amount_unknown` flags (GAP-20); quarantined GAP-35 rows. Anything else
   unexpected → stop, fix the spreadsheet, start Phase 4 again (nothing has
   been written).
3. Tick the confirmation, **Load register**. Record the time — GAP-13's week
   runs from it.

### Phase 5 — Check the load

```sql
SELECT status, count(*) FROM member WHERE member_type = 'player' GROUP BY 1;
SELECT row_type, legacy_channel, count(*) FROM member_number GROUP BY 1, 2;
SELECT s.frequency, count(*), sum(s.annual_basis_pence)/100 AS annual_gbp
  FROM subscription s GROUP BY 1;                       -- standing orders loaded
SELECT count(*) FILTER (WHERE email IS NOT NULL) AS with_email,
       count(*) FILTER (WHERE email IS NULL)     AS post_only FROM member;
SELECT f, count(*) FROM member, jsonb_array_elements_text(verify_flags) f GROUP BY 1;
-- Standing orders whose amount doesn't buy whole £2 weeks per payment:
SELECT amount_pence, frequency, count(*) FROM subscription
 WHERE amount_pence % 200 <> 0 GROUP BY 1, 2 ORDER BY 3 DESC;
```

**Check:** counts tie back to R2 and to the spreadsheet's own PAYING / bank /
agent totals; the last query is reviewed (old-price amounts carry a remainder
that only becomes a week once enough has accumulated).

### Phase 6 — Create the draws

Admin console → **Draws** → **New draw** → *Recurring*: first and last date
(D4), weekly, 12:00, entries close 12 hours before. Name Draw 1 if wanted.

**Check:** 13 draws, numbered consecutively, all open; the Draws page shows 0
entries and a jackpot estimate with "+ N standing orders (est.)" — N should
be roughly the Phase 5 subscription totals ÷ £2 ÷ 52.

### Phase 7 — Numbers for every paying member (GAP-13)

Live, members have a week from the load to choose numbers on the portal
(those with email, via *Forgot password*); everyone else is then given
RANDOM.ORG numbers by the hourly sweep.

1. Optionally prove the portal path with one or two test logins: *Forgot
   password* → set password → choose numbers (emails land in mailpit).
2. **[DRY RUN ONLY]** Skip the week by backdating the load:
   ```sql
   UPDATE member_number SET created_at = created_at - interval '8 days';
   ```
3. Wait for the `selection-random-allocation` schedule (hourly, 200 lines per
   run — about 4–5 runs for the register), or trigger it from the Temporal UI.
4. **Check:**
   ```sql
   -- Active player numbers still without numbers: should reach 0 (agent-collected excluded)
   SELECT count(*) FROM member_number mn JOIN member m ON m.id = mn.member_id
    WHERE mn.row_type = 'member' AND m.status = 'active' AND m.member_type = 'player'
      AND mn.legacy_channel <> 'agent_collected'
      AND NOT EXISTS (SELECT 1 FROM selection_standing ss WHERE ss.prize_draw_no = mn.prize_draw_no);
   ```
   `numbers_allocated` emails in mailpit for members with email; one
   `post_allocated_numbers` task each for the rest (expect most members —
   GAP-05).

### Phase 8 — Match standing-order money

1. Admin console → **Bank statements** → upload R3.
2. With D5's threshold, exact matches allocate themselves; the rest become
   `bank_transaction_review` tasks. Work through them on the **Tasks** page:
   pick the right number and resolve (allocates the payment), or resolve with
   none selected for money that isn't the lottery's.
3. Re-upload the same file once. **Check:** nothing is double-counted
   (`bank_transaction.external_id` dedup).
4. **Check:**
   ```sql
   SELECT match_status, count(*) FROM bank_transaction WHERE is_credit GROUP BY 1;
   SELECT count(*), sum(amount_pence)/100 AS gbp FROM payment WHERE channel = 'so_fps';
   SELECT count(*) FROM human_task WHERE status = 'open';   -- review tasks left
   ```
   Record how long the review took — that is the weekly treasurer workload.
5. **Opening credit (D2 (c))** — weeks paid to the old lottery and not yet
   drawn, from R3a (SETUP §2.2.3). From the repo root, as the owner role:
   ```bash
   export APP_DB_MIGRATION_URL=$OWNER APP_DB_MIGRATION_PASSWORD_FILE=deploy/secrets/app_db_password
   pnpm opening-credit --cutoff <old last draw> --first-draw <Draw 1 date> /root/switchover-dryrun/old/*.csv
   ```
   Read the summary and `opening-credit-<cutoff>.csv` (weeks per number;
   flags `no_payment_in_window`, `no_standing_order`, `amount_differs`,
   `window_shorter_than_cycle`). Fill in the `assign` column of
   `opening-credit-<cutoff>.exceptions.csv` (a prize draw number or
   `ignore`), re-run with `--assign <that file>` until nothing is left to
   assign, then add `--commit --actor "<name>"`. It refuses if any R3
   statement line is dated on or before the cut-off (fix R3, don't force it).
   **Check:**
   ```sql
   SELECT count(*), sum(amount_pence)/200 AS weeks FROM payment WHERE allocation_method = 'legacy_opening_credit';
   ```
   Re-run the `--commit` once: it must credit 0 numbers and list the rest as
   already credited.

### Phase 9 — Readiness check for Draw 1

Entries are placed automatically on statement import and match
(`allocateUpcomingEntries`). Then:

```sql
-- Entries per draw
SELECT d.draw_number, count(e.*) FILTER (WHERE e.voided_at IS NULL) AS entries
  FROM draw d LEFT JOIN entry e ON e.draw_id = d.id GROUP BY 1 ORDER BY 1;

-- D2 measure: paying standing orders with NO entry in Draw 1
-- (after the opening credit, these should be mostly members whose last
-- payment's weeks were used up by the old draws: their next payment is due)
SELECT s.frequency, count(*) FROM subscription s
  JOIN payment_method pm ON pm.id = s.payment_method_id
 WHERE s.status = 'active' AND NOT EXISTS (
   SELECT 1 FROM entry e JOIN draw d ON d.id = e.draw_id
    WHERE d.draw_number = 1 AND e.voided_at IS NULL
      AND e.prize_draw_no = pm.reference::int)
 GROUP BY 1;

-- Money matched but no line to enter (should be 0 after Phase 7)
SELECT count(DISTINCT p.line_prize_draw_no) FROM payment p
 WHERE p.channel = 'so_fps' AND p.status = 'allocated'
   AND NOT EXISTS (SELECT 1 FROM entry e WHERE e.prize_draw_no = p.line_prize_draw_no AND e.voided_at IS NULL);
```

**Go / no-go for Draw 1:**

- [ ] Every matched standing order has an entry in Draw 1 (and later draws
      for multi-week payments).
- [ ] The opening credit is committed, its report reviewed, and the
      "no entry in Draw 1" list is understood and agreed (D2).
- [ ] No open `bank_transaction_review` tasks; `post_allocated_numbers`
      tasks either worked or accepted as post-go-live work.
- [ ] Draws page: entry count and jackpot for Draw 1 look right; rollover 0.
- [ ] `draw-dispatch` schedule present; `RANDOMNESS_SOURCE=random_org`;
      config shows GAP-16/17/21/22/23 with confirmers.
- [ ] Two admin users can log in with MFA.
- [ ] Agents exist and appear in the physical-ticket dropdown.

### Phase 10 — Optional: run Draw 1, then reset

To prove the draw itself: `pnpm exec tsx tools/dev/set-draw-time.ts 1 now`
**[DRY RUN ONLY]**, let `draw-dispatch` start it within 5 minutes, check the
winning numbers, settlement, winner emails (mailpit) and `winner_missing_email`
tasks, and that the rollover reaches Draw 2.

Afterwards: delete R1/R3 copies and the exceptions CSV from the dev host
(B-2); restore `deploy/.env`; either keep the dry-run database for further
testing or restore the Phase 1 backup with `pg_restore`.

---

## 6. What this implies for the live timeline

Working back from Draw 1's entries closing (Friday 00:00):

| When | Step |
|---|---|
| T−3 weeks | VPS built and hardened (SETUP §3), DNS, live secrets, Elavon/SocketLabs live credentials; D1–D7 answered |
| T−2 weeks | Phases 1–3 on the VPS (empty start, config, admin users, agents) |
| **T−9 days at the latest** | Phase 4–6: register loaded, draws created. The 7-day GAP-13 week starts here; letters/emails tell members they can choose numbers |
| T−2 days | Sweep has allocated every remaining number; `post_allocated_numbers` letters printed and posted |
| T−1 day | Final statement uploaded and matched (Phase 8); opening credit committed (Phase 8 step 5, once the old lottery's last draw has run); Phase 9 go / no-go |
| Friday 00:00 | Entries close; 12:00 Draw 1 runs itself (`draw-dispatch`) |

Standing-order money arriving after Thursday's upload but before the
cutoff only counts if a statement is uploaded and matched before 00:00.

---

## 7. Gaps this plan surfaced

| # | Issue | Effect on go-live | Suggested fix |
|---|---|---|---|
| G1 | ~~No opening credit for legacy standing orders paid before cut-over (D2)~~ **Built:** `pnpm opening-credit` (SETUP §2.2.3) | Monthly/quarterly/annual payers would have no entries for weeks or months | Run it in Phase 8 step 5; needs R3a (12 months of old statements) |
| G2 | `activate-config` can't set `recon_auto_threshold` or `selection_cutoff_before` | Manual SQL on the live database | Add both to `OVERRIDABLE_COLUMNS` |
| G3 | `RANDOM_ALLOCATION_GRACE_DAYS` is a constant 7 | Load must happen ≥ 9 days before Draw 1's cutoff | Fine if planned; otherwise make it config |
| G4 | Random allocation covers *every* number of an active member, including their non-paying numbers | Extra allocations and letters for numbers that pay nothing | Restrict the sweep to numbers with an active subscription, or accept |
| G5 | `assertNoSandboxInProduction` (`packages/ports/src/registry.ts`) refuses any sandbox provider under `NODE_ENV=production`. `printHandoff` is hard-wired to `SandboxPrintHandoff` (`apps/worker/src/composition-root.ts`), and `BACS_BUREAU` has only `sandbox` or the refusing `own_sun` (GAP-10) | **The live workers will not start** with `NODE_ENV=production` as the code stands | Before go-live: a real (or explicitly "disabled") print hand-off and Bacs bureau, or a deliberate, recorded exemption. Worth a separate test start of the live config before the live run |
| G6 | Still-blocking gaps for real money: GAP-36/31 limits, GAP-42 on-call, GAP-47 agent wins, TG-08/15 operator | Not dry-run blockers; go-live blockers | Track separately (`gap-register.md`) |
