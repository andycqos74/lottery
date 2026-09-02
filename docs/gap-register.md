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
| GAP-16 | **Draw every Friday, 12:00 noon; entries cut off at Friday 00:00** (12h before draw). Postgres `DOW` convention (0=Sunday..6=Saturday; Friday=5). | `config_version.draw_day_of_week`/`draw_time_local`/`selection_cutoff_before`, active row `5c94ac98-211f-461c-86b7-812d3740b307` — confirmed by Andy Cowan. Not yet consumed: nothing schedules `DrawWorkflow` from it yet |
| GAP-22 / GAP-23 | **Jackpot splits per winning entry** (not per winner); the indivisible remainder goes to the good cause, not to winners or rollover. GAP-15 (must multi-ticket selections be distinct?) is still open and unaffected by this. This governs an ORDINARY match-4 win only — GAP-24's must-be-won roll-down below uses per-winner splitting internally, a separate decision that happens to share a shape, not an answer to this one. | `config_version.share_basis`/`share_remainder_rule`, active row `258a0c16-c26e-4129-a5ec-36d636ef0aef` — confirmed by Andy Cowan. Consumed by `settleDraw()` (`packages/activities/src/draw/settle.ts`), called from `DrawWorkflow` |
| B-7 | **Resolved/all-tasks view.** `/tasks` now takes `?status=open\|resolved\|all` (`listTasksByStatus()`), with tabs in the console. | `apps/admin/src/db.ts`, `apps/admin/src/index.ts`, `apps/admin/src/views.ts` |
| B-8 | **Draw administration surface.** `/draws` list, `/draws/new`, `/draws/:id` detail, and a "run" action now exist. | `apps/admin/src/index.ts`, `apps/admin/src/views.ts` |
| B-9 | **Task decisions now reach the workflow they blocked.** Resolving a `human_task` delivers the named Temporal signal (currently scoped to `must_be_won_decision`; other signal/update names are reported as not-yet-wired rather than silently dropped). | `apps/admin/src/temporal.ts` (`deliverTaskDecision`) |
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
| GAP-17 | **Prepaid blocks.** Each payment buys whole tickets up front; the draw consumes them. | `entriesDue()` (`prepaid_blocks` branch); activate with `config_version.entry_strategy` via `pnpm activate-config`. Wired end to end: admin's "Generate standing-order entries" action (`/draws/:id/generate-entries`) runs `generateDueEntries()` (`packages/activities/src/draw/generate-entries.ts`), deriving each member's remaining prepaid blocks from allocated standing-order/Giro/branch payments minus entries already drawn against them |
| GAP-21 | **RANDOM.ORG**, via its HTTP client interface (https://www.random.org/clients/http/), not a software CSPRNG. Whether independent assurance is ALSO required for the licensing authority remains open — see the residual note in `packages/ports/src/randomness.ts`. | `packages/adapters-live/src/randomness/random-org.ts`; `RANDOMNESS_SOURCE=random_org` |
| GAP-24 | **Roll down to match 3, then match 2, then match 1** — the first tier with a winning entry pays, split equally among that tier's winners. Residual: nobody matching even one number was not covered and still halts. | `resolveMustBeWon()` in `packages/domain/src/allocation.ts` |
| GAP-33 | **Manual CSV upload**, for now. Open Banking and OCR remain live options for later — the port's per-transaction confidence field exists specifically so swapping to either is a new adapter, not a rewrite. Real column mapping and the FR-5.8.2 continuity trade-off are recorded in the GAP-33/B-10 row above. | `packages/adapters-live/src/bank-feed/csv-bank-feed.ts`; `BANK_FEED=csv` |

## Resolved by client decision (2026-09-01)

| ID | Decision | Recorded in |
|---|---|---|
| B-12 | **Manual/physical ticket entry.** Admin staff can key in a physical ticket for an identified member: a physical ticket number (free text, recorded for reference/audit only — never joined against `member_number.prize_draw_no`), a purchase date, and an amount paid. Amount must be a whole multiple of the £2 ticket price; it buys that many prepaid blocks and is treated identically to a standing order from that point on — entered into the currently open draw immediately, and into each future open draw automatically via the existing GAP-17 `prepaid_blocks` machinery. Numbers are either the member's own (as printed on the ticket) or a "quick pick" — a new `selection_source = 'quick_pick'` value, deliberately distinct from GAP-13's still-blocked `'randomly_allocated'`: this is the member's own request to have the system pick, not the system silently defaulting a non-responder. **Not the same problem as GAP-19** (still ⛔): GAP-19 is a bulk agent lodgement with no per-member breakdown at all; this is for a specific, identified member with a known purchase date and amount. | `packages/activities/src/entries/record-manual-ticket.ts` (`recordManualTicket`); `payment.channel = 'agent_cash'` (`db/migrations/0010_manual_ticket_entry.sql`), added to the same standing-order-shaped channel list `generateDueEntries()` reads; `packages/domain/src/selection.ts` (`randomSelection`, entropy injected — this file is imported by workflow code); admin UI at `/draws/:id/manual-tickets` (`apps/admin/src/views.ts`, `drawDetailPage`) |
| B-13 | **Physical tickets are attributed to an agent, not the player.** Client decision, 2026-09-02: the actual player who buys a physical ticket has no account and QOSFC cannot identify or contact them directly. `member.member_type` (`'player'`\|`'agent'`) marks which members can be selected as the attributed party for a physical ticket — the admin form's dropdown is now scoped to agent-type members only, and `recordManualTicket` rejects any other member as the authoritative check. If that ticket wins, notification goes through the normal per-member workflow (GAP-30) but reaches the agent, who holds the real contact details. **Deliberately not the same thing as the legacy `agent` table** (`db/migrations/0002`, GAP-19's bulk-collection entity) — see GAP-47 below for the consequence this creates. | `db/migrations/0011_member_type_agent.sql`; `listAgentMembers()` (`apps/admin/src/db.ts`); `apps/admin/src/views.ts` (members page "Type" field, draw page "Agent" dropdown) |

## Blocking, and where the code stops

| ID | What is undecided | Where it halts |
|---|---|---|
| GAP-01 ⛔ | ELM vs in-house. Everything is conditional on it. | — build proceeds as in-house pending sign-off |
| GAP-02 ⛔ | Switch-over date; cut-over vs parallel run. | — |
| GAP-05 ⛔ | No email address exists anywhere in 1,591 rows. | `member.email` nullable by *fact*, not by choice |
| GAP-09 ⛔ | Payment service provider (real gambling-MCC acquirer) — **still to be confirmed**. Working assumption: a third-party hosted card processing portal (standing orders and Direct Debit are the other two funding channels, and need no PSP). Unblocked for *build* purposes only: the member portal's online purchase flow runs end to end against the sandbox PSP as a dummy transaction simulator, so the flow is provable before an acquirer is chosen — but no real money can move until one is. | `PaymentGateway` port; `PAYMENT_GATEWAY=sandbox`\|`card_portal` — `packages/adapters-live/src/payment/card-portal.ts` is shape-only, every method refuses until a provider is actually chosen; portal flow in `apps/api/src/entries.ts` |
| GAP-10 ⛔ | Bacs route — **still to be confirmed**. Working assumption: the society's own Service User Number, with the option to move to a bureau kept open behind the port. | `BacsBureau` port; `BACS_BUREAU=sandbox`\|`own_sun` — `packages/adapters-live/src/bacs/own-sun.ts` is shape-only, refuses until Bacstel-IP access exists to build against |
| GAP-13 ⛔ | Random allocation for non-responders — drafted, unconfirmed. | `selection_standing.source` may not be written as `randomly_allocated`; the campaign raises a task |
| GAP-19 ⛔ | Agent-collected members — 782 of 1,591, 49% of the register, no functional design at all. **Working assumption:** some form of manual entry into the system, scoped and built in a future phase. | `entriesDue()` → `unresolvedGap('GAP-19')` |
| GAP-36 / 31 ⛔ | Statutory limits and good-cause floor, inconsistently cited across sources. | `config_version.max_*`, `good_cause_floor_bp` — all NULL |
| GAP-42 ⛔ | No escalation policy, no named on-call. The error handling assumes someone eventually looks. | `EscalationWorkflow` exists; its policy does not |
| TG-08 / TG-15 ⛔ | Who operates the platform. | — |
| GAP-47 ⛔ | **Prize payment when a winning entry is agent-attributed** (B-13). QOSFC's only identified/contactable party for a physical ticket is the agent, not the player who actually holds it — so when such an entry wins, who gets paid, how the agent then gets the money to the real ticket-holder, and what evidence QOSFC needs of that handoff are all undecided. Related to but distinct from GAP-30 (notification channel and prize payment mechanism in general): GAP-30 assumes the paid party IS the winner; this is the case where they provably are not. | Notification/settlement for an agent-attributed win is not specially handled anywhere — `resolveMustBeWon()`/`settleDraw()` pay out against the entry's `prize_draw_no` exactly as for any other entry, which is now a live gap the moment a physical ticket can win |

## Non-blocking, carried

| ID | Undecided | Represented by |
|---|---|---|
| GAP-03 | Role permissions / segregation of duties. | `app_role.permissions` — data, not code; defaults to deny |
| GAP-07 | Duplicate prize draw numbers 1253, 1515, 2498. | migration rejects to the exception report |
| GAP-08 | Deceased / estate handling. | `member_status.deceased` exists; policy does not |
| GAP-11 | Payment failure grace period. | `config_version.payment_grace_days` NULL |
| GAP-12 | Refund / DD indemnity policy and its effect on placed entries. | `MandateEvent.indemnity_claim` routed to the member workflow |
| GAP-14 | Selections persistent vs per-draw. | `selection_standing` effective dates support both |
| GAP-15 | Multi-ticket members: distinct selections required? | `assertMultiTicketSelectionsPermitted()` halts |
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
| GAP-45 | Reply-by period. | `config_version.reply_by_days` NULL |
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
