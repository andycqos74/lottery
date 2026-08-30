# QOSFC Lottery Platform

Replaces a manually-administered small society lottery — a spreadsheet register
reconciled by hand against scanned bank statements — with a system that holds the
member register as authoritative data, runs a weekly £2 pick-4-from-20 draw,
maintains an auditable 50/40/10 allocation ledger, and continues to reconcile
legacy standing orders.

Built on Temporal, because the characteristic work here is *waiting*: a week to a
draw, three working days for a Bacs collection, a fortnight to a reply-by date,
months to an unclaimed prize, and an unbounded period for a volunteer to resolve
a low-confidence bank match.

**→ [docs/SETUP.md](docs/SETUP.md)** — full stack setup, local and production.
**→ [docs/gap-register.md](docs/gap-register.md)** — every undecided rule, and
where the code stops rather than guessing.

## Specifications

- `QOSFC_Lottery_Functional_Spec_v0.2.md` — 46 functional gaps, 12 blocking
- `QOSFC_Lottery_Technical_Spec_v0.3.md` — 15 technical gaps, 4 blocking

Requirement references throughout the code (`FR-6.1`, `T-6.1`, `GAP-24`) point
back at these. They are the authority; this repository is the implementation.

## Three rules the tooling enforces

1. **Money is `bigint` pence.** Never a `number`. Watch `SUM(amount_pence)` —
   PostgreSQL returns `numeric` from an aggregate over `int8`, bypassing the
   BigInt parser. Cast `::bigint`, or use `numericToPence()`.
2. **Workflow code does no I/O, reads no clock, and generates no randomness.**
   `pnpm lint` fails the build on `Math.random`, `Date.now`, `crypto`, or a
   database import inside `packages/workflows`. The draw RNG is an *activity* —
   see `packages/ports/src/randomness.ts` for why that is the most important
   distinction in the system.
3. **Undecided rules halt.** Call `unresolvedGap('GAP-nn', …)`; never invent a
   default. The workflow catches it and opens a `human_task`.

## Quick start

```bash
pnpm install
pnpm test          # 104 tests: domain, database security, codec, determinism
pnpm typecheck
pnpm lint
```

The database security suite **skips** without `TEST_APP_DB_URL` rather than
passing, so a green run with no database never looks like proof:

```bash
createdb lottery_test
TEST_APP_DB_URL=postgres://…/lottery_test pnpm test:db
```

Standing the whole stack up — including the dummy PSP, Bacs bureau and bank feed
that let the internal flow be built before those integrations are chosen — is in
[docs/SETUP.md](docs/SETUP.md).

## Layout

```
packages/domain/           pure money, allocation, jackpot, selection — no I/O
packages/db/               schema, migrations, pool, the int8→BigInt parser
packages/ports/            the external-system interfaces
packages/temporal-common/  codec, PII guard, task queues, workflow IDs
packages/workflows/        workflow code only — determinism-linted
packages/activities/       all I/O
packages/adapters-sandbox/ dummy implementations of every port
packages/adapters-live/    empty until GAP-09/10/30/33 resolve
apps/{api,admin,worker}/   the runnable processes
services/sandbox-providers/ the dummy external systems
services/codec-server/     payload decryption oracle for the Temporal UI
deploy/                    compose, bootstrap, host hardening
db/migrations/             schema, and the append-only guarantees
```

## Status

Phases 0–1 of the [build plan](docs/SETUP.md#8-monitoring) are complete:
monorepo, domain arithmetic, schema with database-enforced audit guarantees,
payload encryption, provider ports with sandbox implementations, worker
composition root, and the deployment stack.

**Not yet production-ready.** Twelve blocking functional decisions and four
technical ones are open — see [docs/gap-register.md](docs/gap-register.md). The
system is built so that work proceeds around them: every undecided rule is a
visible pause point, not an invented default.
