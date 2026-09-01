# QOSFC Lottery Platform — Setup

Everything needed to stand the stack up, locally and on a production VPS.

Read the two specifications first — `QOSFC_Lottery_Functional_Spec_v0.2.md` and
`QOSFC_Lottery_Technical_Spec_v0.3.md`. This document does not restate them; it
tells you how to run what they describe.

**Before you go live, read [§9 Blockers](#9-blockers).** Twelve blocking
functional decisions and four blocking technical ones are still open. The system
is built so that work can proceed around them — every undecided rule is a visible
pause point, not an invented default — but several of them must be answered
before real money moves.

---

## 1. What you are deploying

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 22 LTS, TypeScript strict | One language across API, workers and UI |
| Orchestration | Temporal, self-hosted | The workload is dominated by *waiting* |
| System of record | PostgreSQL 16 (`postgres-app`) | T-1.1 — Temporal is never the system of record |
| Orchestration store | PostgreSQL 16, **separate instance** | T-10.3 — separate blast radius |
| Visibility | PostgreSQL advanced visibility, **no Elasticsearch** | T-10.4 — 52 draws a year does not need it |
| Edge | Caddy, TLS, 443 the only public port | §4 |
| Host | Ubuntu 24.04 LTS, Docker Compose | §3 |

Four networks, and the placement *is* the security boundary:

```
                       internet — 443 only
                              │
                        ┌─────▼─────┐
                        │   Caddy   │  TLS · HSTS · CSP · IP allowlist
                        └──┬──┬──┬──┘
        ┌──────────────────┘  │  └──────────────────┐
        ▼                     ▼                     ▼
  ┌───────────────────────────────────────────────────────┐
  │ edge   api · admin · codec-server · temporal-ui        │
  ├───────────────────────────────────────────────────────┤
  │ app    worker-draw · worker-member · worker-payments   │  ← unreachable
  │        worker-recon · worker-comms · [worker-migration]│    from internet
  ├───────────────────────────────────────────────────────┤
  │ core   temporal · postgres-app · postgres-temporal     │  ← internal: true
  │        (no ingress from edge, no internet egress)      │    no egress at all
  ├───────────────────────────────────────────────────────┤
  │ sandbox  sandbox-providers · mailpit   DEV/STAGING ONLY│
  └───────────────────────────────────────────────────────┘
```

Workers sit on `app` and `core` but **not** `edge`: nothing from the internet can
reach a worker even through a misconfigured reverse proxy.

---

## 2. Local development

You need Docker with Compose v2, Node 22+, and pnpm 10+.

```bash
git clone git@github.com:andycqos74/lottery.git
cd lottery
pnpm install

# 1. Resolve every third-party image to an immutable digest.
#    A tag is a mutable pointer; `postgres:16` can become different bytes without
#    any change in version control. Commit the generated images.env.
./deploy/bootstrap/pin-digests.sh

# 2. Generate secrets. They are FILES under deploy/secrets/, never env vars —
#    an env var leaks into `docker inspect` and every child process.
./deploy/bootstrap/generate-secrets.sh

# 3. Configure.
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env       # set TEMPORAL_CODEC_ACTIVE_KEY_ID to the id printed in step 2

# 4. Bring up the datastores and Temporal.
cd deploy/compose
docker compose --env-file images.env --env-file ../.env \
  -f docker-compose.core.yml up -d

# 5. Temporal schema, namespace, and search attributes.
#    Re-run this after every Temporal version bump — see §7.
cd ../.. && ./deploy/bootstrap/bootstrap-temporal.sh

# 6. Application database: the login role, the migrations, and a check that the
#    append-only guarantee actually holds.
./deploy/bootstrap/bootstrap-app-db.sh

# 7. Application and dummy providers.
cd deploy/compose
docker compose --env-file images.env --env-file ../.env \
  -f docker-compose.core.yml -f docker-compose.app.yml -f docker-compose.sandbox.yml up -d

# 8. THE PHASE 1 GATE. Nothing else gets built until this passes.
cd ../.. && pnpm verify:stack
```

`pnpm verify:stack` checks the things that are cheap now and expensive later:

- both databases reachable and migrated
- `int8` parses to `BigInt` — if this fails, money silently becomes floating point
- `lottery_app` holds no `UPDATE`/`DELETE` on `ledger_entry` or `audit_log`
- the encryption codec round-trips, and plaintext is absent from the ciphertext
- the PII guard detects personal data without false-positiving on identifiers
- every custom search attribute is registered — unregistered ones fail at
  *runtime*, mid-draw (T-10.7)
- **Workflow Update works end to end** (T-10.8). `change_selection` and the
  human-task resolution path both depend on it, and whether it needs explicit
  enablement has changed across server releases. Discovering this late is
  expensive; discovering it here costs nothing.

### 2.1 The admin console

`apps/admin` (build plan §5, GAP-43) is the human task inbox — a rendered
database table, deliberately **not** the Temporal Web UI, so a volunteer
treasurer is never asked to send a raw signal from a developer tool to release
a stuck prize payment.

There is no self-service signup (T-9.3: individual named accounts, mandatory
MFA, no shared logins). Create the first account from the repo root, once
`postgres-app` is up and migrated:

```bash
ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" pnpm create:admin-user
```

This prints a generated password and a TOTP enrollment key/QR URI **once** —
neither is recoverable afterwards (the password is hashed, the TOTP secret is
encrypted at rest under `deploy/secrets/admin_mfa_key`, generated alongside
the other secrets by `generate-secrets.sh`). Add the TOTP key to an
authenticator app, then log in at `http://<ADMIN_HOST>/login` — password
first, then a 6-digit code.

Tasks with `requires_second_approver` (GAP-44) need two *different* accounts
to approve before they resolve — the console enforces this the same way the
database does (`human_task`'s `approvers_must_be_different` constraint).

The console now also covers draw administration (`/draws` list, detail, and
running a draw) and basic member management, alongside the task inbox — `/tasks`
covers open, resolved, and all tasks (`?status=`), and resolving a task
delivers the Temporal signal it names to the blocked workflow
(gap-register.md B-7/B-8/B-9). It also uploads bank statement CSVs (§2.2) and
reviews the reconciliation tasks they raise. GAP-17/21/24/33 are resolved (see
`docs/gap-register.md`); **not yet built:** payments and anything else gated
on GAP-09/10/19, none of which are resolved yet (§9).

### 2.2 Bank reconciliation (GAP-33)

Andy Cowan confirmed CSV upload as the starting point; Open Banking is left for
future consideration, and OCR is not pursued. Admin uploads a file at
`/bank-statements`; `CsvBankFeed`
(`packages/adapters-live/src/bank-feed/csv-bank-feed.ts`) detects which of two
schemas it is from its header row and dispatches accordingly:

- The bank's own **"TransactionHistory" export**
  (`real-export-csv-format.ts`, B-10 — resolved once a real sample existed).
  This is a flat transaction list, not a statement: it carries no
  opening/closing balance at all, so FR-5.8.2's continuity check cannot run
  against it. Andy Cowan's direction: drop the check for this feed rather than
  block on it — see the ingestion note below.
- The **canonical schema** we invented before a real sample existed
  (`csv-format.ts`, `#statement <n> ... <openingPence> <closingPence>` plus a
  header row) — still supported, mainly useful for fixtures and tests, since
  it is the one shape that does carry a balance and so is the one FR-5.8.2 can
  actually check.

Each row becomes a `bank_transaction`; credits are matched against
`member_number.prize_draw_no` by reference
(`packages/activities/src/reconcile/match-transactions.ts`). TG-04's
auto-accept confidence threshold is unset, so **every credit becomes a review
task** — nothing is auto-allocated yet. That is the documented default
behaviour (gap-register.md TG-04), not a bug.

**Reviewing a task is what allocates the money (B-11).** A
`bank_transaction_review` task's detail page lists its candidates; picking one
and resolving calls `acceptBankTransactionMatchTx()`, which accepts that
candidate, marks the transaction matched, and creates the `payment` row
(FR-5.8.3) — before that, closing the task alone left the credit reviewed but
still unallocated. Leaving no candidate selected still resolves the task, for
a transaction genuinely nobody can identify.

**Continuity and dedup.** `ingestNewStatements` only runs the FR-5.8.2 opening/
closing-balance check when a batch actually carries both figures. When it
doesn't (the real export, always), the batch is ingested anyway with
`chain_verified = false`, and correctness instead rests on
`bank_transaction.external_id` — a stable per-row identity from the source,
unique in the database — so that two exports whose date ranges overlap (a
plausible weekly/monthly upload pattern) do not double-count the transactions
they share. Re-introducing statement-level continuity checking for this feed
is explicit future-phase work, contingent on the bank ever offering an export
that carries a balance.

### 2.2.1 Standing orders into entries (GAP-17)

Reconciling a payment (2.2) does not by itself put a member into a draw —
GAP-17's resolved strategy (prepaid blocks: each payment buys whole tickets
up front, each draw consumes one) has to actually run. On a draw's detail
page while it's still `open`, "Generate standing-order entries" calls
`generateDueEntries()` (`packages/activities/src/draw/generate-entries.ts`)
for every member with an active persistent selection
(`selection_standing`, GAP-14) and a linked `member_number`: it derives their
remaining prepaid blocks (allocated standing-order/Giro/branch payments,
divided into ticket-price blocks, minus entries already drawn against them
with `funding_source = 'prepaid'`) and writes one entry per member who still
has a block left. Idempotent on `<drawId>:<prizeDrawNo>:1`, same as the
manual entry path (T-8.2), so re-running it is harmless.

This only takes effect once GAP-17's strategy is actually active —
`entriesDue()` halts with an `UnresolvedGapError` otherwise, surfaced in the
admin console as a plain error rather than a 500. Activate it once with:

```bash
ENTRY_STRATEGY=prepaid_blocks ENTRY_STRATEGY_CONFIRMED_BY="Andy Cowan, 2026-08-30" \
NOTE="GAP-17 activated for testing" pnpm activate-config
```

Do this **before** closing entries for a draw — once closed, the entry set is
frozen (FR-5.3.3) and a member who hasn't been swept in yet gets nothing that
week.

### 2.3 Member portal (GAP-04, GAP-09)

`apps/api` now also serves member self-service: register/login (password only —
T-9.3's mandatory MFA applies to admin accounts, not members) and an online
entry-purchase flow. Since GAP-09 (the real card acquirer) is still open, the
purchase flow runs against the same sandbox `PaymentGateway` the worker uses —
a dummy endpoint that simulates a transaction end to end (hosted session,
async webhook, success/decline) — so the flow is provable now and swaps to a
live acquirer the same way every other port does (§5 "Adding a live
provider"), with no portal code changes.

Per GAP-04 (confirmed by Andy Cowan): legacy members will get logins too, and
their existing standing orders keep running unchanged in the meantime.
Translating those legacy payment records into the new `payment_method`/
`subscription` model, and provisioning legacy members with portal credentials,
is **explicit future-phase work** — not attempted in this build.

### Running the tests

```bash
pnpm test:unit          # domain arithmetic — no infrastructure needed
pnpm test:property      # the T-12.1 money invariants
pnpm typecheck
pnpm lint               # includes the workflow determinism rules — see §5

# Database security guarantees, against a real PostgreSQL:
createdb lottery_test
TEST_APP_DB_URL=postgres://…/lottery_test pnpm vitest run packages/db
```

The database suite **skips** without `TEST_APP_DB_URL` rather than passing, so a
green CI run with no database never looks like proof.

---

## 3. Production VPS

### 3.1 Sizing — read this before ordering

The technical spec's reference topology (T2) is two 4 vCPU / 8 GB compute nodes
plus a separate 4 vCPU / 8 GB database host. This deployment collapses all of it
onto one box, and TG-12 resolved to **entity-workflow-per-member**, which T-10.5
explicitly says not to downsize for. Committed memory:

| Component | RAM |
|---|---|
| `temporal` (frontend + history + matching + worker in one process) | 1.5 GB |
| 5 × `worker-*` (`recon` largest — OCR) | 2.0 GB |
| `api` + `admin` | 0.75 GB |
| `temporal-ui` + `codec-server` | 0.4 GB |
| `postgres-app` (`shared_buffers` 1.5 GB) | ~2.5 GB |
| `postgres-temporal` (`shared_buffers` 1.5 GB, `max_connections` 200) | ~2.5 GB |
| OS, Docker, headroom | 2.0 GB |
| **Total** | **~11.7 GB** |

**Specify 8 vCPU / 16 GB / 250 GB SSD, UK region.** An 8 GB box will not carry
this design. If budget caps at 8 GB, TG-12 must be reopened *before* Phase 5 —
switching to batch entry generation later is a rewrite of the member domain, not
a config change.

The 250 GB is mostly WAL, backup staging, and headroom: event history runs about
1 GB/year at identifier-only payload sizes.

> **Accepted risk, to be recorded in writing (T-10.13):** this is a single point
> of failure. Loss of the host **delays** a draw; it never produces a wrong one
> (NFR-7). Recovery is restore-from-backup, and how long that takes depends on
> GAP-42 and TG-15 — nobody has yet been identified to notice.

### 3.2 Host preparation

On a fresh Ubuntu 24.04 LTS VPS, as root:

```bash
git clone https://github.com/andycqos74/lottery.git /opt/qosfc
cd /opt/qosfc

ADMIN_ALLOWED_CIDRS="203.0.113.0/24" SSH_PORT=22 ./deploy/host/harden.sh
```

That script is idempotent and does: security packages; unattended security
upgrades (rebooting at 04:00, never during a Saturday draw); a non-root `deploy`
user; SSH keys-only with root login disabled; an `nftables` default-deny firewall
where **443 is the only thing the world sees** and SSH is restricted to your
CIDRs; `fail2ban`; a Docker daemon with `userns-remap`, `no-new-privileges` and
inter-container communication off; and audit rules on the secrets directory,
firewall and SSH config.

**Keep a second SSH session open while you run it.** Confirm you can still get in
before closing the first.

Then prove the exposure is what you think it is, **from another machine**:

```bash
./deploy/host/verify-exposure.sh <public-ip> 22
```

It asserts 443 and SSH are open and that Postgres, the Temporal frontend and
internal ports, the app ports, mailpit, the sandbox providers, and the Docker
daemon are all closed. Checking from the box itself proves nothing — loopback
bindings look open from inside and shut from outside.

### 3.3 DNS and deployment

Point five A records at the VPS: `PUBLIC_HOST`, `MEMBER_HOST`, `ADMIN_HOST`,
`TEMPORAL_UI_HOST`, `CODEC_HOST`. Caddy obtains certificates automatically on
first request.

```bash
cd /opt/qosfc
./deploy/bootstrap/pin-digests.sh
./deploy/bootstrap/generate-secrets.sh
cp deploy/.env.example deploy/.env && $EDITOR deploy/.env

cd deploy/compose
docker compose --env-file images.env --env-file ../.env \
  -f docker-compose.core.yml -f docker-compose.app.yml -f docker-compose.edge.yml \
  up -d
```

Note what is **absent** from that command: `docker-compose.sandbox.yml`. The dummy
providers are never deployed to production, and the composition root refuses to
start with `NODE_ENV=production` against any sandbox adapter — belt and braces,
because a sandbox PSP left wired in on go-live would look exactly like everything
working.

---

## 4. Security posture

| Control | Where |
|---|---|
| 443 the only public port; internal networks have no egress | `docker-compose.*.yml`, `harden.sh` |
| TLS, HSTS, strict CSP with no `unsafe-inline`, frame-ancestors none | `deploy/compose/Caddyfile` |
| Admin console and Temporal UI IP-allowlisted **in front of** authentication | `Caddyfile` |
| Containers non-root, read-only rootfs, `cap_drop: ALL`, `no-new-privileges` | `docker-compose.app.yml` |
| OCR container isolated with no internet egress — it parses untrusted PDFs | `worker-recon` |
| Secrets as mounted files, never environment variables | `generate-secrets.sh` |
| Images pinned by immutable digest | `pin-digests.sh` |
| Workflow payloads encrypted at rest, AES-256-GCM, versioned keys | `packages/temporal-common/src/codec/` |
| Identifier-only payloads, enforced by lint **and** at runtime | `eslint.config.js`, `pii-guard.ts` |
| Append-only ledger enforced by **revoked grants**, not application code | `db/migrations/0007` |
| Draw and prize immutability enforced by trigger | `db/migrations/0007` |
| Ledger transactions must sum to zero — deferred constraint trigger | `db/migrations/0005` |
| Dual approval enforced by the **workflow**, and by a DB constraint | `human_task`, GAP-44 |
| No card data in the system: PSP-hosted fields only, PAN-shaped tokens refused | `payment_method` |

Two of these deserve emphasis because they are unusual:

**The application cannot rewrite the books.** `lottery_app` has no `UPDATE` or
`DELETE` grant on `ledger_entry` or `audit_log`. Not "should not" — the privilege
does not exist, so a bug in a workflow or a compromised application session
cannot alter a financial record. Corrections are compensating entries (T-8.4).

**The draw RNG is an activity, never workflow randomness.** T-6.1 is described by
the technical spec as the single most important line in it. Workflow-deterministic
randomness would make the winning numbers a function of run identity — predictable
to anyone who can observe it, and reproducible by a workflow reset. The ESLint
config bans `Math.random`, `crypto`, and `Date` inside `packages/workflows` and
`packages/domain`, so a violation fails the build rather than a code review.

### 4.1 Key custody — an open decision

`generate-secrets.sh` writes the codec key to `deploy/secrets/codec/<id>.key`.
Back that directory up **off the machine, encrypted**. Without the key, existing
Temporal workflow history cannot be decrypted during exactly the incident when
someone needs to read it.

Who holds the recovery copy, and where, is the residual half of TG-11 and has not
been decided. Rotation is supported — add a new key file, point
`TEMPORAL_CODEC_ACTIVE_KEY_ID` at it, and keep the old file so older history stays
readable.

---

## 5. Working on the code

```
packages/domain/           pure money, allocation, jackpot, selection — no I/O
packages/db/               schema, migrations, pool, the int8→BigInt parser
packages/ports/            PaymentGateway, BacsBureau, BankFeed, Notifier,
                           RandomnessSource, EntryGenerationStrategy
packages/temporal-common/  codec, PII guard, task queues, workflow IDs, client
packages/workflows/        workflow code only — determinism-linted
packages/activities/       all I/O
packages/adapters-sandbox/ dummy implementations of every port
packages/adapters-live/    random.org (real) and CSV bank feed (real); card
                           portal and own-SUN Bacs are shape-only pending
                           GAP-09/10; empty for GAP-30
apps/{api,admin,worker}/   the three runnable processes
services/sandbox-providers/ the dummy PSP, Bacs bureau, bank feed
services/codec-server/     payload decryption oracle for the Temporal UI
```

Three rules the tooling enforces so you do not have to remember them:

1. **Money is `bigint` pence.** Never `number`. Watch for
   `SUM(amount_pence)` — PostgreSQL returns `numeric` from an aggregate over
   `int8`, which bypasses the BigInt parser and arrives as a string. Cast
   `::bigint` in SQL, or use `numericToPence()`. `packages/db/src/types.ts`
   explains the trap.
2. **Workflow code does no I/O, reads no clock, and generates no randomness.**
   `pnpm lint` fails the build on `Math.random`, `Date.now`, `crypto`, `pg`, or
   an import from `@qosfc/db` inside `packages/workflows`.
3. **Undecided rules halt.** Call `unresolvedGap('GAP-nn', …)` — never invent a
   default. The workflow catches it and opens a `human_task`. See
   `packages/domain/src/gaps.ts`.

### Adding a live provider

1. Implement the port in `packages/adapters-live/`.
2. Map the provider's errors onto `TransientProviderError` and
   `PermanentProviderError` — failure semantics belong to the port, so retry
   behaviour does not change when the provider does.
3. Run the shared contract suite against it. **A live adapter is done when it
   passes the same suite the sandbox passes.**
4. Change one environment variable. No workflow or activity code changes.

---

## 6. Backups

Both PostgreSQL instances get WAL archiving and PITR to off-site object storage
via pgBackRest, encrypted client-side. `postgres-app` is the recovery-critical
asset: losing `postgres-temporal` loses no financial fact (T-1.1), though losing
it mid-draw still means reconstructing state by hand.

T-10.16 says restores are *tested on a schedule, not assumed*. That is
implemented literally as `BackupVerificationWorkflow` — a scheduled workflow that
restores the latest backup into a scratch instance, asserts row counts and ledger
balance, and opens a `human_task` if it fails **or if it has not run**.

---

## 7. Upgrades

T-10.14: *"Upgrades are the real cost of self-hosting, not the hardware."*

```bash
$EDITOR deploy/bootstrap/pin-digests.sh    # bump TEMPORAL_VERSION
./deploy/bootstrap/pin-digests.sh          # re-resolve digests, commit images.env
./deploy/bootstrap/bootstrap-temporal.sh   # apply schema migrations
cd deploy/compose && docker compose --env-file images.env --env-file ../.env \
  -f docker-compose.core.yml -f docker-compose.app.yml up -d
pnpm verify:stack
```

Temporal server and `admin-tools` versions must match, the SDK must be compatible
with the server, and there are limits on how many versions may be skipped in one
step — check the compatibility matrix before bumping. Rehearse on staging first.

Worker deployments use Worker Versioning (T-6.5) rather than in-place
replacement, so in-flight draws and member workflows keep the rules they started
under. That is a compliance property, not a convenience: a member's entries for a
completed draw stay governed by the rules in force at that draw (FR-5.4.4).

On the single-node topology an upgrade is a brief outage. That is acceptable
under NFR-7 — a draw is delayed, never wrong — but do not run one on a draw day.

---

## 8. Monitoring

At minimum (T-10.17): Temporal service health; task-queue backlog per queue;
workflow terminal failures; activity retry exhaustion; `human_task` age against
`due_at`; PostgreSQL disk headroom and WAL archive success; and the business-level
check that catches everything else — **any draw workflow that has not reached
`settled` within its expected window**.

Watch `pg_relation_size('executions_visibility')` too: it is the table that bloats
quietly on SQL-backed visibility (T-10.4).

---

## 9. Blockers

The system is deliberately built so these do not stop the build. Each is a
visible pause point: the process reaches the undecided rule, opens a
`human_task`, and waits. None is silently pre-empted by a plausible default.

But several must be answered **before real money moves**.

### Must be answered before go-live

| Gap | Decision needed | Who decides |
|---|---|---|
| **GAP-01** ⛔ | ELM vs in-house, formally | Client/board |
| **GAP-21** *(source resolved: RANDOM.ORG)* | Whether independent assurance is ALSO required | **Licensing authority** |
| **GAP-36 / 31** ⛔ | Statutory limits and the good-cause floor, from the regulator not a spreadsheet | **Licensing authority** |
| **GAP-42** ⛔ | Escalation policy and a named on-call | Client |
| **GAP-09** ⛔ | PSP — working assumption is a third-party hosted card portal, still to be confirmed | Client + acquirer |
| **GAP-10** ⛔ | Bacs route — working assumption is the society's own SUN, still to be confirmed | Client + acquirer |
| **GAP-19** ⛔ | Entry model for the 782 agent-collected members — 49% of the register. Working assumption: manual entry, scoped for a future phase | Client |
| **GAP-13** ⛔ | Random allocation of numbers for non-responders | Client |
| **GAP-05** ⛔ | How member contact details are captured — no email exists in 1,591 rows | Client |
| **GAP-02** ⛔ | Switch-over date; cut-over vs parallel run | Client |
| **GAP-16** | Draw day, time and cut-off — `DrawWorkflow` cannot be scheduled without it | Client |
| **GAP-40** | One agreed population definition before any count is coded into a report | Client |
| **TG-08 / TG-15** | Who operates the platform: upgrades, restore drills, a node down on draw night | Client |

### Surfaced by this build

1. **The source data files are not in the repository.**
   `Lottery_Database_Cleaned_2026.xlsx`, `Lottery_New_Model_2GBP.xlsx`,
   `SO_address_gaps.csv` and the statement history are referenced throughout both
   specs but absent. Phase 2 needs either the files or agreed synthetic fixtures
   matching their exact columns.
2. **Real member data must not enter dev or CI.** The default fixture must be a
   generated synthetic register — same shape, same quirks, fake people. This
   needs confirming as policy, not assumed. `.gitignore` blocks `*.xlsx` and
   `data/real/` as a first line of defence.
3. **VPS provider and region not chosen** (TG-02/TG-03). UK region required; a
   processor agreement is needed with whoever is chosen; off-site backup storage
   should *not* be the same provider.
4. **Domain names and TLS ownership** (TG-06), relative to the existing Wix estate.
5. **Sizing** — §3.1. 16 GB, or reopen TG-12 now.
6. **Codec key custody** (TG-11 residual) — §4.1.

The full register, with every gap mapped to the config key or pause point that
represents it, is in [`docs/gap-register.md`](gap-register.md).
