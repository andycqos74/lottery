# Gap register

Every undecided rule, and the exact place in the code where the system stops
rather than guessing.

This is the operational companion to the specifications' own registers
(functional §16, technical §14). It exists so that when a decision arrives,
whoever implements it can find the one place it belongs.

**The governing rule** (functional FR-5.6, technical §15): a gap becomes a *pause
point*, never a branch. The process reaches the undecided rule, opens a
`human_task`, and waits for a human. Where a strategy interface has several
implementations, the unselected ones fail explicitly rather than falling through
to the plausible-looking one.

⛔ = blocking.

## Resolved in planning

| ID | Decision | Recorded in |
|---|---|---|
| GAP-06 | **Person-as-member.** One member holds many legacy prize draw numbers. | `db/migrations/0002_members.sql` |
| TG-01 / TG-09 | **TypeScript on Node 22, PostgreSQL 16.** | `package.json`, `tsconfig.base.json` |
| TG-08 *(partly)* | **Self-hosted, single VPS, Docker Compose.** The "who operates it" half stays open — see TG-15. | `deploy/compose/`, `docs/SETUP.md` §3 |
| TG-11 | **Identifier-only payloads AND an encryption codec.** Both, from day one. | `packages/temporal-common/src/codec/`, `pii-guard.ts` |
| TG-12 | **Entity-workflow-per-member.** Drives the sizing in SETUP §3.1. | `packages/temporal-common/src/task-queues.ts` |
| TG-13 | **Nexus not adopted.** Recorded, not overlooked. | this file |
| GAP-16 | **Draw every Friday, 12:00 noon; entries cut off at Friday 00:00** (12h before draw). Postgres `DOW` convention (0=Sunday..6=Saturday; Friday=5). | `config_version.draw_day_of_week`/`draw_time_local`/`selection_cutoff_before`, active row `5c94ac98-211f-461c-86b7-812d3740b307` — confirmed by Andy Cowan. Used as the default draw time and cutoff on the admin console's recurring-draw form (`/draws/new`, GitHub #4), which stores each draw's `draw_at`/`entries_close_at` (`db/migrations/0015`). **Draws now run themselves:** the `draw-dispatch` Temporal Schedule starts `DrawWorkflow` for every open draw within 5 minutes of its `draw_at` (`packages/workflows/src/draw-dispatch.ts`, `packages/temporal-common/src/schedules.ts`), with a `DrawWatchdogWorkflow` that raises a `draw_overdue` task if the run has not settled 2 hours later. The workflow generates the due entries and closes the draw itself; the admin console's "run" starts the same workflow under the same `draw-<id>` ID, so the two can never both run a draw |
| GAP-22 / GAP-23 | **Jackpot splits per winning entry** (not per winner); the indivisible remainder goes to the good cause, not to winners or rollover. GAP-15 (distinct selections required, resolved 2026-10-01) does not change this. This governs an ORDINARY match-4 win only — GAP-24's must-be-won roll-down below uses per-winner splitting internally, a separate decision that happens to share a shape, not an answer to this one. | `config_version.share_basis`/`share_remainder_rule`, active row `258a0c16-c26e-4129-a5ec-36d636ef0aef` — confirmed by Andy Cowan. Consumed by `settleDraw()` (`packages/activities/src/draw/settle.ts`), called from `DrawWorkflow` |
| B-7 | **Resolved/all-tasks view.** `/tasks` now takes `?status=open\|resolved\|all` (`listTasksByStatus()`), with tabs in the console. | `apps/admin/src/db.ts`, `apps/admin/src/index.ts`, `apps/admin/src/views.ts` |
| B-8 | **Draw administration surface.** `/draws` list, `/draws/new`, `/draws/:id` detail, and a "run" action now exist. | `apps/admin/src/index.ts`, `apps/admin/src/views.ts` |
| B-9 | **Task decisions now reach the workflow they blocked.** Resolving a `human_task` delivers the named Temporal signal (currently scoped to `must_be_won_decision` and `retry_draw`; other signal/update names are reported as not-yet-wired rather than silently dropped), and tells the task's `EscalationWorkflow` to stop. | `apps/admin/src/temporal.ts` (`deliverTaskDecision`, `notifyEscalationTaskClosed`) |
| GAP-33 | **CSV upload first; Open Banking left for future consideration.** OCR is not pursued either — confirmed by Andy Cowan. The `BankFeed` port was built to fit all three candidate shapes from day one, so this was a selection, not a rewrite. | `BANK_FEED=csv`; `packages/adapters-live/src/bank-feed/csv-bank-feed.ts`; reconciliation in `packages/activities/src/reconcile/` |
| GAP-33 / B-10 | **Real column mapping done; FR-5.8.2 continuity dropped for this feed.** The bank's actual export is a "TransactionHistory" report, not a statement — it has no opening/closing balance column at all, so the continuity check that requires one cannot run against it. Andy Cowan's direction: drop the check for this feed rather than block on it, dedupe by transaction identity instead (`bank_transaction.external_id`, unique), and revisit continuity checking — a future-phase item — only if the bank ever offers a balance-bearing export. | `packages/adapters-live/src/bank-feed/real-export-csv-format.ts`; `db/migrations/0009_bank_transaction_no_balance_feed.sql`; `ingestNewStatements` in `packages/activities/src/reconcile/ingest-statement.ts` |
| B-11 *(resolved)* | Resolving a `bank_transaction_review` task only closed the task — it never created the `payment` row or accepted a `match_candidate`, so a reviewed standing order was still never counted as money received (FR-5.8.3). | Admin's task detail page now shows the candidates for that transaction; picking one and resolving calls `acceptBankTransactionMatchTx()` (`packages/activities/src/reconcile/match-transactions.ts`), which allocates the payment before the task closes. Leaving none selected still resolves the task without allocating anything, for a transaction nobody can identify |
| GAP-04 | **Legacy members will get logins.** Their existing standing orders continue running unchanged; translating them into the new payment/entry model (`payment_method`/`subscription`) is explicit **future-phase work**, not part of this build — confirmed by Andy Cowan. | `member_credential` (`db/migrations/0008_member_login.sql`); portal auth in `apps/api/src/auth.ts`. Legacy-standing-order translation: not started, deliberately |

## Resolved by client decision (2026-08-30)

Answered directly by the client. Each is now live in code, not just recorded
here — see §"When a decision arrives" below for how a `config_version` row or
a live adapter puts one into force.

| ID | Decision | Recorded in |
|---|---|---|
| GAP-17 | **Prepaid blocks.** Each payment buys whole tickets up front; each draw uses one. | `entriesDue()` (`prepaid_blocks` branch) is the gate — activate with `config_version.entry_strategy` via `pnpm activate-config`; until then nothing paid can be entered. Weeks are counted per line (allocated card/standing-order/Giro/branch/physical-ticket payments ÷ £2, minus live paid entries) and entered into upcoming draws as soon as they exist, before any Direct Debit — see B-17/B-18. Direct Debit collections are not weeks: a mandate enters its line itself (GitHub #9). |
| GAP-21 | **RANDOM.ORG**, via its HTTP client interface (https://www.random.org/clients/http/), not a software CSPRNG. Whether independent assurance is ALSO required for the licensing authority remains open — see the residual note in `packages/ports/src/randomness.ts`. | `packages/adapters-live/src/randomness/random-org.ts`; `RANDOMNESS_SOURCE=random_org` |
| GAP-24 | **Roll down to match 3, then match 2, then match 1** — the first tier with a winning entry pays, split equally among that tier's winners. Residual: nobody matching even one number was not covered and still halts. | `resolveMustBeWon()` in `packages/domain/src/allocation.ts`. **Wired end to end:** `DrawWorkflow` counts the tiers (`countRollDownTiers`) and `settleDraw` pays the winning tier from the frozen entry set, recording the tier in `draw.must_be_won_decision`. Only the residual case still opens a `must_be_won_decision` task (two approvers, GAP-44) |
| GAP-33 | **Manual CSV upload**, for now. Open Banking and OCR remain live options for later — the port's per-transaction confidence field exists specifically so swapping to either is a new adapter, not a rewrite. Real column mapping and the FR-5.8.2 continuity trade-off are recorded in the GAP-33/B-10 row above. | `packages/adapters-live/src/bank-feed/csv-bank-feed.ts`; `BANK_FEED=csv` |

## Resolved by client decision (2026-09-01)

| ID | Decision | Recorded in |
|---|---|---|
| B-12 | **Manual/physical ticket entry.** Admin staff can key in a physical ticket for an identified member: a physical ticket number (free text, recorded for reference/audit only — never joined against `member_number.prize_draw_no`), a purchase date, and a number of weeks (GitHub #6: the amount paid is derived as weeks × £2, and the admin must tick to confirm the money has been paid). Each week is one prepaid block and is treated identically to a standing order from that point on — entered into the currently open draw immediately, and into each future open draw automatically via the existing GAP-17 `prepaid_blocks` machinery. Numbers are either the member's own (as printed on the ticket) or a "quick pick" — a new `selection_source = 'quick_pick'` value, deliberately distinct from GAP-13's `'randomly_allocated'`: this is the member's own request to have the system pick, not a line nobody chose numbers for. Since GAP-19 was resolved as option (c), this is also how agent-collected players are entered: one ticket each, keyed in against their agent from the agent's weekly pay-in. | `packages/activities/src/entries/record-manual-ticket.ts` (`recordManualTicket`); `payment.channel = 'agent_cash'` (`db/migrations/0010_manual_ticket_entry.sql`), added to the same standing-order-shaped channel list `generateDueEntries()` reads; `packages/domain/src/selection.ts` (`randomSelection`, entropy injected — this file is imported by workflow code); admin UI at `/draws/:id/manual-tickets` (`apps/admin/src/views.ts`, `drawDetailPage`) |
| B-13 | **Physical tickets are attributed to an agent, not the player.** Client decision, 2026-09-02: the actual player who buys a physical ticket has no account and QOSFC cannot identify or contact them directly. `member.member_type` (`'player'`\|`'agent'`) marks which members can be selected as the attributed party for a physical ticket — the admin form's dropdown is now scoped to agent-type members only, and `recordManualTicket` rejects any other member as the authoritative check. If that ticket wins, notification goes through the normal per-member workflow (GAP-30) but reaches the agent, who holds the real contact details. **Deliberately not the same thing as the legacy `agent` table** (`db/migrations/0002`, GAP-19's bulk-collection entity) — see GAP-47 below for the consequence this creates. | `db/migrations/0011_member_type_agent.sql`; `listAgentMembers()` (`apps/admin/src/db.ts`); `apps/admin/src/views.ts` (members page "Type" field, draw page "Agent" dropdown) |

## Resolved by client decision (2026-09-27 – 2026-10-01: testing feedback)

From the client's testing-feedback round (GitHub issues #4–#12) and follow-up
instructions on 2026-10-01.

| ID | Decision | Recorded in |
|---|---|---|
| GAP-14 | **Selections persist until changed.** A member's numbers stay entered into every draw while they have paid weeks or a Direct Debit for them. Each set of numbers a member holds is a *line* (a `selection_standing` slot on their prize draw number). **Changing them:** the member on the portal's "My numbers" page, or staff on the admin member page, can change a line's numbers. The line keeps its paid weeks and any Direct Debit; entries in draws still taking entries take the new numbers, draws closed to entries keep the old ones, and a player can't put the same numbers on two lines (GAP-15). The old numbers are closed, not overwritten, and the change is audited. | `selection_standing` (slot = line); `allocateUpcomingEntries()` (`packages/activities/src/draw/allocate-upcoming.ts`); `db/migrations/0018`; `changeLineNumbers()` (`packages/activities/src/entries/change-numbers.ts`), portal `POST /numbers/change`, admin `POST /members/:id/numbers` |
| GAP-15 | **Distinct selections required.** A member never has two entries in one draw with the same numbers. Buying again with numbers they already hold adds weeks to those numbers instead. Agents are exempt: their physical tickets belong to different players. Shares are per winning entry (GAP-22), so this never changes a payout. | `assertMultiTicketSelectionsPermitted()` (`packages/domain/src/selection.ts`); enforced by `allocateUpcomingEntries()` (withdraws a same-number duplicate in a draw still taking entries) and admin "Add entry" (`apps/admin/src/db.ts`, `addEntry`) |
| B-14 | **Draws are scheduled, named, and close to entries before they are drawn** (GitHub #4, #5). No more defaulting to today: a one-off draw takes a draw date/time and an entries-close date/time; a recurring series takes start/end dates, weekly/fortnightly/monthly, a draw time and a cutoff in hours before each draw, and every draw in it is created up front. Times are UK time. Draws have an optional free-text name. Entries are refused after the cutoff; money or a mandate arriving after a draw's cutoff counts from the next draw. | `db/migrations/0015` (`draw.name/draw_at/entries_close_at`, `draw_schedule`); `apps/admin/src/draw-schedule.ts`; admin `/draws/new`; portal `getOpenDraw()` (the soonest draw still taking entries) |
| B-15 | **An unwon jackpot rolls into the next draw** (GitHub #10). Each draw starts from the previous settled draw's rollover out; settlement records `rollover_in_pence`, `jackpot_pre_draw_pence` and `floor_topup_pence`, and moves the rolled-in money from the rollover ledger account to the prize fund. Draws should be run in date order. | `getRolloverIn` activity (`packages/activities/src/draw/rollover.ts`); `DrawWorkflow` (behind `workflow.patched('rollover-in-from-previous-draw')`); `settleDraw()` |
| B-16 | **Draws summary shows entries and jackpot for every draw** (GitHub #7): live entry counts for open draws, the settled jackpot or an estimate for unsettled ones (50% of entries so far + standing orders expected but unpaid + the rollover waiting, never below the floor), and totals. | admin `/draws` (`apps/admin/src/views.ts`, `drawsPage`); `estimateStandingOrderEntries()` |
| B-17 | **Entries are made as soon as draws exist**, so members see they are entered and each jackpot counts its entries (2026-10-01). Paid weeks (card blocks, physical tickets, matched standing-order money) and Direct Debits are entered into every draw still taking entries on draw creation, purchase, ticket, Direct Debit setup or cancellation, and bank statement import/match; running a draw re-checks (`generateDueEntries`). Standing orders not yet paid are *estimated* into the jackpot, never entered. Entries are never deleted: a withdrawn entry is voided. | `allocateUpcomingEntries()`; `estimateStandingOrderEntries()`; `db/migrations/0017` (`entry.voided_at/void_reason`) — every entry count, winner scan and member view ignores voided entries |
| B-18 | **Card first; same numbers add weeks, different numbers add an entry** (GitHub #8, #9, #11; 2026-10-01). A card purchase or Direct Debit setup is matched against the member's lines: same numbers add to that line (more weeks, or a mandate behind it); different numbers start a new line, an extra entry alongside. Paid weeks are always used first — a Direct Debit already in place pauses for those draws and resumes after; one set up after a card payment starts once the paid draws run out. A Direct Debit enters its line into every draw until cancelled; cancelling withdraws its entries from draws still taking entries. The member is told what was done, on screen and by email. The payment page asks card or Direct Debit first; only card asks how many draws. | `resolveLine()` / `describeLineOutcome()` (`packages/activities/src/entries/lines.ts`); `payment`/`payment_method.line_prize_draw_no/line_slot` (`db/migrations/0018`); `completeEntryPurchase()` (`apps/api/src/entries.ts`); `completeDirectDebitSetup()` / `cancelDirectDebit()` (`apps/api/src/direct-debit.ts`) |

## Resolved by client decision (2026-10-06)

| ID | Decision | Recorded in |
|---|---|---|
| GAP-01 | **In-house build**, not ELM — confirmed by Andy Cowan. What the build was already proceeding on; nothing in the code was conditional on the other answer. | this file |
| GAP-02 | **Clean cut-over**, no parallel run — confirmed by Andy Cowan. The switch-over date is a project-plan date, not an undecided rule, so it is no longer tracked as a gap. | this file |
| GAP-05 | **Some email addresses will be populated on the final data load. A postal address only matters if the member wins and has no email** — then a task asks a person to contact them by post — confirmed by Andy Cowan. `notifyWinners` (called by `DrawWorkflow` after settlement) emails winners who have an address and opens one `winner_missing_email` task per draw for each winner who has none, pointing at the member page; resolving that task in the admin console marks their prizes `notified`. Nothing else ever raises a task for a missing email. These tasks escalate on the normal 24-hour cadence (GAP-42) and sort normally. Postal address: `address_1`, `address_2`, `address_3` (town), new `county`, `post_code`, all optional; editable with email, telephone and preferred contact on the admin member page, and by the member on the portal's details page. | `db/migrations/0021`; `notifyWinners()` (`packages/activities/src/draw/notify-winners.ts`); `markPrizesNotifiedByPost()`, `updateMemberContact()` (`apps/admin/src/db.ts`), admin `POST /members/:id/contact`; portal `/details` |
| GAP-13 | **Members who have not picked numbers are allocated them at random, a week after their number was issued, always from RANDOM.ORG, every line different, and told by email or post** — confirmed by Andy Cowan. The `selection-random-allocation` Schedule (hourly) runs `RandomAllocationSweepWorkflow`: every active player's prize draw number with no numbers at all, issued (`member_number.created_at` — the final data load, for the legacy register) 7+ days ago, gets four numbers from RANDOM.ORG as `selection_source = 'randomly_allocated'` (audited, with the RANDOM.ORG evidence). It refuses to run on any other `RANDOMNESS_SOURCE`, sandbox included. A draw identical to another of the member's lines is redrawn (GAP-15). The member gets one `numbers_allocated` email listing every allocated line, or — with no email, or a rejected send — one `post_allocated_numbers` task to post them. The allocation is then a standing selection like any other (GAP-14), entered into upcoming draws whenever there is money or a mandate behind it. Agent-collected numbers are excluded (GAP-19 below). This also answers GAP-45 for number selection: one week. | `db/migrations/0021`; `allocateRandomSelections()` (`packages/activities/src/entries/random-allocation.ts`); `packages/workflows/src/random-allocation.ts`; `packages/temporal-common/src/schedules.ts`; `numbers_allocated` template (`packages/adapters-live/src/notify/socketlabs.ts`) |
| GAP-19 | **Option (c): agent-collected players are entered only as physical tickets attributed to their agent** — confirmed by Andy Cowan. The agents are set up manually (agent-type members, B-13) before switch-over; each agent pays in weekly, and staff key each player's ticket in through "Record a physical/agent ticket" (B-12), attributed to the agent. The players are contactable only via their agent. So an agent-collected number is owed nothing in its own right — `entriesDue()` returns zero for it instead of halting — and the random allocation (GAP-13) leaves it alone. A winning agent ticket notifies and pays the agent; how the agent then pays the player is still GAP-47. | `entriesDue()` (`packages/domain/src/entry-generation.ts`); `recordManualTicket()` (`packages/activities/src/entries/record-manual-ticket.ts`); admin `/draws/:id/manual-tickets` |

## Resolved by client decision (2026-10-07: Direct Debit management)

| ID | Decision | Recorded in |
|---|---|---|
| DD collection | **Monthly collection, payment in advance.** On the 1st of each month (or the next working day) each confirmed mandate is collected £2 for every Direct Debit entry on its line in draws up to the end of that month not already collected for — that month's draws, plus any the mandate entered before its first collection. Paid weeks on the same numbers are still used first (B-18), so those draws cost nothing here. The member is told the amount and date 10–14 days before (the Direct Debit Guarantee's advance notice) by email, or by a `post_dd_notice` task. Batches go to the bureau 2 working days before the collection date. An entry in a scheduled, submitted or collected collection is protected: cancelling, or buying weeks on the same numbers, never withdraws it. | `dd_collection_cycle`, `dd_collection`, `dd_collection_entry` (`db/migrations/0022`); `prepareCollections()`, `submitDueCollections()`, `processCollectionResults()` (`packages/activities/src/direct-debit/collections.ts`); calendar in `dates.ts`; `DirectDebitWorkflow` on the `direct-debit` Schedule (every 15 minutes, payments queue) |
| DD pending | **A mandate the bank has not confirmed enters nothing.** Entries start from the bank's confirmation (`mandate_active` event), counted from `payment_method.mandate_active_at`. Mandates recorded before this existed were carried forward as confirmed. | `allocateUpcomingEntries()`; `activateMandate()`; `processMandateEvents()` (`packages/activities/src/direct-debit/mandate-events.ts`) |
| GAP-11 | **A failed collection is retried once, a week later; a second failure stops the Direct Debit** and withdraws its unpaid entries from draws still taking entries. The member is told each time; a `dd_collection_stopped` task tells the treasurer how many draws were played unpaid. | `processCollectionResults()`; `endDirectDebit()` (`packages/activities/src/direct-debit/mandates.ts`). `config_version.payment_grace_days` stays unused — the rule is the retry, not a number of days |
| GAP-12 | **A refund (indemnity) claim means removal.** The refunded collections become `refunded` and their payments `reversed`, the Direct Debit ends, and every entry they paid for in a draw still taking entries is withdrawn. A `dd_refund_claim` task records it, including any refunded draws already played. | `applyRefundClaim()` in `mandate-events.ts` |
| DD cancel | **Cancelling — by the member, by staff, after a second failure, or on a refund claim — also cancels the mandate with the bureau**, done by the Direct Debit workflow (`bureau_cancel_pending`), so only the worker talks to the bank. Cancelling at the bank by the payer arrives as a `mandate_cancelled` event and ends it here. Entries already paid for stay. | `endDirectDebit()`, `cancelMandatesAtBureau()`; `BacsBureau.cancelMandate`; portal `/direct-debit/cancel`; admin `POST /members/:id/direct-debits/:pmId/cancel` |
| DD admin | **Direct Debit management in the admin console**: `/direct-debits` lists every mandate and its status, failed or rejected collections, and recent collections; each member page shows their Direct Debits with collection history and a cancel button. The portal shows the member whether their bank has confirmed, the next collection's amount and date, and past collections. | `apps/admin/src/views.ts` (`directDebitsPage`, member page); `listActiveDirectDebits()` (`apps/api/src/direct-debit.ts`) |


## Blocking, and where the code stops

| ID | What is undecided | Where it halts |
|---|---|---|
| GAP-09 | Payment service provider — **Elavon Payment Gateway (EPG)**, hosted payment page in full-page redirect mode (client decision, GitHub #12, following the club's own Wix EPG integration). Built and selectable; real money moves once live merchant credentials (gambling-MCC underwriting is Elavon's side) are in place. Standing orders and Direct Debit remain the other funding channels and need no PSP. | `PaymentGateway` port; `PAYMENT_GATEWAY=sandbox`\|`elavon`\|`card_portal` — `packages/adapters-live/src/payment/elavon/` (`ElavonPaymentGateway`, reference ↔ EPG order/session mapping in `elavon_payment_session`, `db/migrations/0016`); portal flow in `apps/api/src/entries.ts`; setup in `docs/SETUP.md` §2.3 |
| GAP-10 ⛔ | Bacs route — **still to be confirmed**. Working assumption: the society's own Service User Number, with the option to move to a bureau kept open behind the port. | `BacsBureau` port; `BACS_BUREAU=sandbox`\|`own_sun` — `packages/adapters-live/src/bacs/own-sun.ts` is shape-only, refuses until Bacstel-IP access exists to build against Everything else about Direct Debit is built against the port (see "Resolved by client decision (2026-10-07)"): only the real adapter waits for this — its API or file format, hosted mandate page, AUDDIS/ARUDD/ADDACS delivery, submission cut-offs and bank-holiday calendar (`dates.ts` skips weekends only), reference format and the SUN to print on notices. |
| GAP-36 / 31 ⛔ | Statutory limits and good-cause floor, inconsistently cited across sources. | `config_version.max_*`, `good_cause_floor_bp` — all NULL |
| GAP-42 ⛔ | No escalation policy, no named on-call. The error handling assumes someone eventually looks. | `EscalationWorkflow` exists (`packages/workflows/src/escalation.ts`); its policy does not. Every open task gets one, started by the `task-escalation-sweep` Schedule. Until GAP-42 is decided, escalating only raises `human_task.escalation_level` (the inbox sorts and badges by it) and writes `human_task.escalated` to `audit_log` — nobody is notified. The cadence is a placeholder: first at `due_at` (or 24h after opening), then every 24h (`ESCALATION_INTERVAL_MS`) |
| TG-08 / TG-15 ⛔ | Who operates the platform. | — |
| GAP-47 ⛔ | **Prize payment when a winning entry is agent-attributed** (B-13). QOSFC's only identified/contactable party for a physical ticket is the agent, not the player who actually holds it — so when such an entry wins, who gets paid, how the agent then gets the money to the real ticket-holder, and what evidence QOSFC needs of that handoff are all undecided. Related to but distinct from GAP-30 (notification channel and prize payment mechanism in general): GAP-30 assumes the paid party IS the winner; this is the case where they provably are not. | Notification/settlement for an agent-attributed win is not specially handled anywhere — `resolveMustBeWon()`/`settleDraw()` pay out against the entry's `prize_draw_no` exactly as for any other entry, which is now a live gap the moment a physical ticket can win |

## Non-blocking, carried

| ID | Undecided | Represented by |
|---|---|---|
| GAP-03 | Role permissions / segregation of duties. | `app_role.permissions` — data, not code; defaults to deny |
| GAP-07 | Duplicate prize draw numbers 1253, 1515, 2498. | migration rejects to the exception report |
| GAP-08 | Deceased / estate handling. | `member_status.deceased` exists; policy does not |
| GAP-18 | Prepaid vs credit timing. | Answered by the GAP-17 choice (prepaid blocks = prepaid, not credit) — not separately confirmed as its own decision |
| GAP-20 | 806 members with no amount; 838 tiered Undetermined. | migration flags `amount_unknown`, excludes from entry generation |
| GAP-25 | Reserve funding for the £500 floor; behaviour when empty. | `draw.floor_topup_pence` recorded; funding rule absent |
| GAP-26 | Per-person entry cap. Syndicate exposure is live from day one. | `perPersonEntryCap` honoured when set; unset is reported |
| GAP-27 | Revenue recognition: cash received vs entry face value. | — |
| GAP-28 | Claim period and unclaimed prize policy. | `config_version.claim_period_days` NULL |
| GAP-29 | Winner publicity and consent. | — |
| GAP-30 | Notification channel and prize payment mechanism. | `Notifier` / `PrintHandoff` ports |
| GAP-32 | Good-cause disbursement authorisation. | `GoodCauseDisbursementWorkflow`, dual approval |
| GAP-34 | Statements 563–589 never processed; payment status provisional. | migration exception report |
| GAP-35 | Open member queries: Pattie #1304 / ref 0022; Alan Henry's ten rows. | quarantined on migration |
| GAP-37 | Age verification method. | `member.date_of_birth` + the 18-year CHECK |
| GAP-38 | Statutory return content and format. | `StatutoryReturnWorkflow` |
| GAP-39 | GDPR lawful basis and marketing consent. | required before any bulk mailing |
| GAP-40 | Member counts do not reconcile. | migration reconciliation stage **fails** the run |
| GAP-41 | £8.64 vs £8.68 Deluxe. | `legacy_payment_raw` kept verbatim; **not** normalised |
| GAP-43 | Task inbox design and owner. | `human_task` table + admin console, never the Temporal UI |
| GAP-44 | Manual override authority, incl. the £20,000 decision. | quorum enforced by the workflow **and** `approvers_must_be_different` |
| GAP-45 | Reply-by period. Answered for number selection — one week before random allocation (GAP-13, `RANDOM_ALLOCATION_GRACE_DAYS`); any other reply-by use is still open. | `config_version.reply_by_days` NULL |
| GAP-46 | Notification retry and abandonment policy. | — |
| TG-02 | Hosting budget and operational ownership. | — |
| TG-03 | Data residency and processor agreements. | — |
| TG-04 | Auto-allocation confidence threshold. | `config_version.recon_auto_threshold` NULL — every match is a review task until set |
| TG-05 | Accounting export target. | — |
| TG-06 | Relationship to the Wix estate. | — |
| TG-07 | Record retention policy (years — distinct from TG-10). | `RetentionWorkflow` |
| TG-10 | Namespace history retention (days — an orchestration log, never evidence). | 30d suggested in `bootstrap-temporal.sh` |
| TG-14 | Temporal Cloud quote, to close TG-08. | — |

## Surfaced by the build

| # | Blocker | Needed |
|---|---|---|
| B-1 | Source `.xlsx`/`.csv` files absent from the repository. | The files, or agreed synthetic fixtures matching their exact columns |
| B-2 | Real member data must be barred from dev and CI. | Confirmation as policy; synthetic register as the default fixture |
| B-3 | VPS provider and region unchosen. | UK region, processor agreement, separate backup provider |
| B-4 | Domain names and TLS ownership. | Relative to the existing Wix estate |
| B-5 | 16 GB needed for T1 + entity-per-member. | Budget confirmation, or reopen TG-12 before Phase 5 |
| B-6 | Codec key recovery custody. | Who holds the off-machine copy, and where |
| B-10 *(resolved)* | `CsvBankFeed` (GAP-33) reads a canonical CSV schema we defined ourselves — nobody had yet mapped a real bank export's actual column layout onto it. | Done: `real-export-csv-format.ts` maps the bank's "TransactionHistory" export directly; `CsvBankFeed` detects which of the two schemas an uploaded file is by its header. Surfaced a new limitation, recorded against GAP-33 above: that export carries no balance, so FR-5.8.2 continuity does not run against it |

## When a decision arrives

1. **A parameter** → insert a new `config_version` row and flip `is_active`,
   via `pnpm activate-config` (`packages/db/src/cli/activate-config.ts`) — it
   carries every other column forward from the current active row so setting
   one decision can never silently reset another. Never `UPDATE` — configuration
   is versioned by insertion so a draw already in flight cannot be altered
   (T-3.1).
2. **A strategy** → set the value *and* its `*_confirmed_by` column. A value
   without a named confirmer is a suggestion, and the code treats it as unset.
3. **A rule** → update the specification documents and this register.
4. **Made by unblocking a live process** → it is already in `audit_log`, with the
   actor, via the human task that carried it.
