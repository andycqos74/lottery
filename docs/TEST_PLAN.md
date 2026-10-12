# Test plan

What is tested, how to run all of it, what the last full run found, and what
is still untested. Requirement references (`T-9.3`, `GAP-04`, …) point at the
specifications and [gap-register.md](gap-register.md).

## 1. Test levels

| Level | What it proves | Lives in | Needs |
|---|---|---|---|
| Unit / property | Money, allocation, jackpot, selection, legacy-register planning, CSV formats, codecs, TOTP | `packages/domain`, `packages/*/src/**/*.test.ts`, `apps/admin/src/{totp,secret-box}.test.ts` | nothing |
| Determinism guard | Workflow code cannot use clock, randomness, crypto or the DB (T-6.1–6.3) | `tools/determinism-guard.test.ts` | nothing |
| Database integration | Activities against real PostgreSQL; append-only, grants and triggers enforced by the DB (T-9.4, FR-13.2) | `**/*.integration.test.ts` | `TEST_APP_DB_URL` |
| Application-role privilege | The app role is *physically* unable to rewrite the ledger (T-9.4) | `packages/db/src/security.integration.test.ts` | `TEST_APP_ROLE_DB_URL` |
| Workflow | Draw, dispatch, watchdog, escalation under Temporal's time-skipping server | `packages/workflows/src/*.test.ts` | `TEST_WORKFLOW_ENV=1` (downloads the test server) |
| Black-box HTTP (e2e) | The real admin, member-API and codec-server processes, over HTTP: auth wall, MFA, sessions, CSRF, reset, open redirect, CORS | `**/*.e2e.test.ts`, helper `tools/test-support/server-process.ts` | `TEST_APP_DB_URL` (codec suite needs nothing) |

Each gated suite **skips** when its variable is missing — it never passes
silently. A green run is only proof for the levels whose variables were set.

## 2. Running everything

```bash
pnpm install
createdb lottery_test
# A login role inside lottery_app, for the T-9.4 privilege test:
psql -d lottery_test -c "CREATE ROLE lottery_app_login LOGIN PASSWORD 'app' IN ROLE lottery_app"   # after one migrate

export TEST_APP_DB_URL=postgres://<superuser>@localhost/lottery_test
export TEST_APP_ROLE_DB_URL=postgres://lottery_app_login:app@localhost/lottery_test
export TEST_WORKFLOW_ENV=1

pnpm typecheck && pnpm lint && pnpm test   # everything, ~2 min
pnpm test:e2e                              # just the black-box HTTP suites
```

The integration and e2e suites each `DROP SCHEMA public CASCADE` on the shared
test database; `vitest.config.ts` runs files sequentially so they cannot race.
Never point `TEST_APP_DB_URL` at a database you want to keep.

## 3. Coverage map

| Area | Requirements | Covered by | Gaps in coverage |
|---|---|---|---|
| Money & allocation | T-2.1–2.3, NFR-2, T-12.1 | `allocation`, `prize-sharing`, `entry-generation` (incl. fast-check properties) | — |
| Draw selection & RNG | FR-6, T-6.x | `selection`, `csprng`, `random-org`, `draw/run.integration`, `draw.test` | Statistical uniformity is a single tolerance check, not a chi-square over the live adapter |
| Draw lifecycle | B-14, GAP-14/15 | `allocate-upcoming`, `generate-entries`, `rollover`, `run`, `draws.integration`, `draw-schedule`, `scheduled.test` | Admin `POST /draws/:id/run`, `/manual-tickets` not exercised over HTTP |
| Winners | GAP-05 | `notify-winners.integration` | — |
| Reconciliation | FR-11, GAP-24 | `reconcile.integration`, `csv-format`, `real-export-csv-format` | Admin `/bank-statements` upload over HTTP |
| Direct Debit | GAP-10/12, DD cancel | `direct-debit.integration` | Portal `/direct-debit/*` over HTTP |
| Legacy register | GAP-04 | `legacy-register`, `import-legacy-register.integration` | Portal login for imported members — see F-3 |
| Database guarantees | T-9.4, FR-13.2, FR-5.3.3 | `security.integration` | — |
| Admin auth & MFA | T-9.3 | **`apps/admin/src/auth.e2e.test.ts`**, **`totp.test.ts`**, **`secret-box.test.ts`** | Role permissions (GAP-03 undecided) |
| Member auth | GAP-04 | **`apps/api/src/auth.e2e.test.ts`**, `entries.integration` | — |
| Payload encryption | TG-11, T-10.11 | `encryption-codec`, `pii-guard`, **`services/codec-server/src/codec-server.e2e.test.ts`** | — |
| Payments (Elavon) | GAP-09 | `elavon-gateway`, `pg-store.integration` | Against Elavon's own sandbox (manual, credentials needed) |
| Ops | T-10.16 restore drills | — | Backup/restore, `deploy/host/verify-exposure.sh`, `verify-stack.ts` are manual |

## 4. Last full run — 2026-10-11

PostgreSQL 16, Node 22, all variables in §2 set.

| | Files | Tests | Result |
|---|---|---|---|
| Before this round, no variables (as `pnpm test` runs by default) | 17 run / 18 skipped | 170 passed / 121 skipped | green |
| Before this round, all variables | 35 | 291 | **291 passed** |
| After this round, all variables | 40 | 387 | **387 passed** (incl. 9 `it.fails` known gaps) |

`typecheck` and `lint` are clean.

### New tests this round (96)

- `apps/admin/src/totp.test.ts` (21) — RFC 6238 Appendix B vectors, ±1 step drift and no wider, malformed codes, secret entropy, `otpauth://` URI.
- `apps/admin/src/secret-box.test.ts` (10) — AES-GCM round-trip, fresh IV, wrong key, bit-flip in IV/tag/ciphertext, truncation.
- `apps/admin/src/auth.e2e.test.ts` (29) — auth wall on every page, unknown-email vs wrong-password indistinguishable and audited, no-MFA and deactivated accounts, pending-MFA cookie alone opens nothing, MFA failure audited, tampered/unsigned cookies, deactivation ends live sessions, CSRF on mutations and across admins, logout.
- `apps/api/src/auth.e2e.test.ts` (27) — registration (argon2id, enumeration-safe), login, cookie flags, inactive members, cookie tampering, 8 open-redirect payloads on `next`, CSRF on JSON and form routes, password reset (hash-only storage, single use, expiry, superseded link, short password).
- `services/codec-server/src/codec-server.e2e.test.ts` (9) — UI-origin decode, round-trip, 4 hostile origins, preflight, key-id path traversal.

## 5. Findings

**All nine are fixed** (2026-10-12): each former `it.fails` test is now an
ordinary `it` in a "fixed test-plan findings" block of the named suite, and
CI runs the workflow and app-role suites and typechecks the tests.

| Fixed by | |
|---|---|
| F-1 | Each signed cookie names its purpose (`p: 'session' \| 'mfa_pending' \| 'member_session'`) and is read only as that; a session also needs a non-empty CSRF token. |
| F-2 | The codec server requires a token (`CODEC_AUTH_TOKEN_FILE`) on `/encode` and `/decode`, as Bearer or as an HTTP Basic password; the Temporal UI sends the browser's stored credentials (`TEMPORAL_CODEC_INCLUDE_CREDENTIALS`). |
| F-3 | `/forgot-password` issues a link to any active member with that email; following it creates the portal login if there is none. `/register` still refuses an email on file. |
| F-4 | `member_email_unique` (migration 0026); the losing insert maps to `email_taken`. |
| F-5 | 10 wrong passwords (or MFA codes) per account, or 50 per client address, in 15 minutes lock that key with a 429 and `Retry-After`; success clears the account. Reset-link requests: 5 per email, 20 per address, per hour (`FailureThrottle`, `packages/domain`). |
| F-6 | A session epoch per account (`app_user.session_epoch`, `member_credential.session_epoch`) is carried in the cookie and checked on every request. Admin logout and member password reset raise it, ending every copy. |
| F-7 | `app_user.totp_last_step`: a code is accepted only for a later 30-second step than the last one accepted, in one atomic UPDATE. |
| F-8 | CI creates `lottery_app_login` and sets `TEST_APP_ROLE_DB_URL` and `TEST_WORKFLOW_ENV=1`; the app-role test now skips visibly instead of passing when the variable is missing. |
| F-9 | `tsconfig.eslint.json` compiles (`declarationMap: false`), the type errors in tests are fixed, and CI runs `pnpm typecheck:tests`. |

As found:

| # | Severity | Finding | Test |
|---|---|---|---|
| F-1 ([#40](https://github.com/andycqos74/lottery/issues/40)) | **High** | **Latent MFA bypass.** `@fastify/cookie` signs the value, not the name. The pending-MFA cookie (`{"uid":…}`, issued after the password alone) is accepted as a session cookie by the auth hook, which sets `authUser`. Every page currently 500s only because `escapeHtml(undefined)` throws on the missing CSRF token; any route that does not render that token would serve data without the second factor. Fix: in `currentUser`, require `typeof session.csrf === 'string'`, or add a purpose field to each cookie and check it. | admin `auth.e2e` |
| F-2 ([#41](https://github.com/andycqos74/lottery/issues/41)) | Medium | **Codec server has no authentication**, though `services/codec-server/src/index.ts` and the Caddyfile both say it does. The Origin check is skipped when no `Origin` header is sent, so anything inside the admin IP allowlist or on the `edge` Docker network can decrypt workflow history. | codec `e2e` |
| F-3 ([#42](https://github.com/andycqos74/lottery/issues/42)) | Medium | **GAP-04 contradiction:** an imported legacy member with an email but no `member_credential` cannot register (email taken) and cannot reset a password (no portal login found). The decided rule says legacy members will get logins. | api `auth.e2e` |
| F-4 ([#43](https://github.com/andycqos74/lottery/issues/43)) | Medium | **Duplicate members on concurrent registration.** `registerMember` checks then inserts, and `member.email` has no unique constraint. 20 concurrent calls with one email produced duplicates in 30/30 trials; login then picks an arbitrary row. | api `auth.e2e` |
| F-5 ([#44](https://github.com/andycqos74/lottery/issues/44)) | Medium | **No login throttling or lockout** on admin or member login (30 wrong passwords, no 429). The API's `trustProxy` comment mentions rate limiting; none is registered. | both `auth.e2e` |
| F-6 ([#45](https://github.com/andycqos74/lottery/issues/45)) | Low | **Sessions are not revocable.** Admin logout and member password reset clear the browser's cookie, but a copy stays valid (12 h admin, 30 days member). | both `auth.e2e` |
| F-7 ([#46](https://github.com/andycqos74/lottery/issues/46)) | Low | **TOTP codes can be replayed** within their ~90 s acceptance window. | admin `auth.e2e` |
| F-8 ([#47](https://github.com/andycqos74/lottery/issues/47)) | Test infra | **CI under-tests.** `TEST_WORKFLOW_ENV` is unset, so the 16 workflow tests never run in CI. `TEST_APP_ROLE_DB_URL` is unset, so the T-9.4 "app role cannot UPDATE/DELETE the ledger" test returns early and passes vacuously (it does pass when given a role, checked in this run). | — |
| F-9 ([#48](https://github.com/andycqos74/lottery/issues/48)) | Test infra | **Test files are never typechecked.** Every package's `tsconfig` excludes `*.test.ts`, and `tsconfig.eslint.json` does not compile (`declarationMap` without `declaration`). Forcing it shows 17 type errors in existing tests (e.g. `composition-root.test.ts` passes a `ProviderEnv` field that no longer exists). | — |

## 6. Next cycles

1. ~~Fix F-1~~ and ~~the CI gaps (F-8, F-9)~~ — done, with the rest of §5.
2. **Admin mutations over HTTP:** create a draw, add a member, change numbers, upload a statement, resolve a task — each checking the audit row and the database state, with the same e2e harness.
3. **Portal money flows over HTTP:** purchase → sandbox payment return → entries; DD setup → return → cancel. Needs `services/sandbox-providers` started by the harness.
4. **Restore drill (T-10.16):** restore the latest backup to a scratch instance, check row counts and that the ledger balances. A scheduled job, not a unit test.
5. **Manual acceptance with a volunteer**, on the sandbox stack (`docs/SETUP.md`): one weekly cycle end to end. Schedule the draw, take an online entry and a DD entry, upload a statement with one clear and one ambiguous match, resolve the review task, run the draw, check the 50/40/10 split and the winner email or postal-contact task.
