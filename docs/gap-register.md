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

## Blocking, and where the code stops

| ID | What is undecided | Where it halts |
|---|---|---|
| GAP-01 ⛔ | ELM vs in-house. Everything is conditional on it. | — build proceeds as in-house pending sign-off |
| GAP-02 ⛔ | Switch-over date; cut-over vs parallel run. | — |
| GAP-05 ⛔ | No email address exists anywhere in 1,591 rows. | `member.email` nullable by *fact*, not by choice |
| GAP-09 ⛔ | Payment service provider. | `PaymentGateway` port; `PAYMENT_GATEWAY=sandbox` |
| GAP-10 ⛔ | Bacs route: bureau vs GoCardless vs own SUN. | `BacsBureau` port; `BACS_BUREAU=sandbox` |
| GAP-13 ⛔ | Random allocation for non-responders — drafted, unconfirmed. | `selection_standing.source` may not be written as `randomly_allocated`; the campaign raises a task |
| GAP-17 ⛔ | Entry generation: balance ledger / fixed schedule / prepaid blocks. All three implemented; none is default. | `entriesDue()` → `unresolvedGap('GAP-17')` |
| GAP-19 ⛔ | Agent-collected members — 782 of 1,591, 49% of the register, no functional design at all. | `entriesDue()` → `unresolvedGap('GAP-19')` |
| GAP-21 ⛔ | RNG method and independent assurance. A **licence condition**, not a preference. | `RandomnessSource` port; `RANDOMNESS_SOURCE=unset` |
| GAP-24 ⛔ | Must-be-won mechanism at £20,000. D4 removed every lower tier, so there is nothing to roll down to. | `resolveMustBeWon()` → halts; `DrawWorkflow` opens `must_be_won_decision` |
| GAP-33 ⛔ | Bank feed: Open Banking / CSV / continued OCR. | `BankFeed` port; all three shapes in the sandbox |
| GAP-36 / 31 ⛔ | Statutory limits and good-cause floor, inconsistently cited across sources. | `config_version.max_*`, `good_cause_floor_bp` — all NULL |
| GAP-42 ⛔ | No escalation policy, no named on-call. The error handling assumes someone eventually looks. | `EscalationWorkflow` exists; its policy does not |
| TG-08 / TG-15 ⛔ | Who operates the platform. | — |

## Non-blocking, carried

| ID | Undecided | Represented by |
|---|---|---|
| GAP-03 | Role permissions / segregation of duties. | `app_role.permissions` — data, not code; defaults to deny |
| GAP-04 | Whether legacy members get logins. | — |
| GAP-07 | Duplicate prize draw numbers 1253, 1515, 2498. | migration rejects to the exception report |
| GAP-08 | Deceased / estate handling. | `member_status.deceased` exists; policy does not |
| GAP-11 | Payment failure grace period. | `config_version.payment_grace_days` NULL |
| GAP-12 | Refund / DD indemnity policy and its effect on placed entries. | `MandateEvent.indemnity_claim` routed to the member workflow |
| GAP-14 | Selections persistent vs per-draw. | `selection_standing` effective dates support both |
| GAP-15 | Multi-ticket members: distinct selections required? | `assertMultiTicketSelectionsPermitted()` halts |
| GAP-16 | Draw day, time, cut-off. | `config_version.draw_day_of_week` etc. NULL |
| GAP-18 | Prepaid vs credit timing. | implicit in the GAP-17 strategy choice |
| GAP-20 | 806 members with no amount; 838 tiered Undetermined. | migration flags `amount_unknown`, excludes from entry generation |
| GAP-22 | Jackpot shared per winner or per winning entry. | `shareJackpot()` halts without a confirmed policy |
| GAP-23 | Rounding rule for an indivisible remainder. | same |
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

## When a decision arrives

1. **A parameter** → insert a new `config_version` row and flip `is_active`.
   Never `UPDATE` — configuration is versioned by insertion so a draw already in
   flight cannot be altered (T-3.1).
2. **A strategy** → set the value *and* its `*_confirmed_by` column. A value
   without a named confirmer is a suggestion, and the code treats it as unset.
3. **A rule** → update the specification documents and this register.
4. **Made by unblocking a live process** → it is already in `audit_log`, with the
   actor, via the human task that carried it.
