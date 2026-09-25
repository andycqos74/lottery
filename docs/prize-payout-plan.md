# Prize payout — plan

How a winning member gets paid. Status: **proposal**, not built. It turns
GAP-30 ("notification channel and prize payment mechanism") into a concrete
design and lists the decisions it still needs (§9).

It fits into what already exists:

- `settleDraw()` (`packages/activities/src/draw/settle.ts`) already writes a
  `prize` row per winning entry with status `pending_notification`, and credits
  the winner's `member_balance` ledger account.
- `prize.payout_idempotency_key` (T-8.2) and `workflowIds.prize()` →
  `prize-<uuid>` (`packages/temporal-common/src/task-queues.ts`) are already
  reserved for this.
- `Notifier` / `PrintHandoff` (`packages/ports/src/notifier.ts`) are the contact
  ports; `human_task` is the pause mechanism.

---

## 1. Pay by bank transfer, not back to a card

Agreed. Bank transfer (Faster Payments) should be the default payout rail:

| | Bank transfer | Card payout (OCT / "push to card") |
|---|---|---|
| Who can receive it | Every winner with a UK bank account | Only members who paid by card, and only if the PSP supports payouts |
| Standing order / DD / agent-cash members | ✅ | ❌ no card on file; that's most of the register |
| Depends on GAP-09 | No | Yes. The acquirer is still undecided, and many gambling-MCC acquirers don't offer OCTs |
| Arrives | Usually minutes (FPS) | Minutes to days, depending on the issuer |
| Cost | Pence per payment, or free from a business account | Per-transaction fee, often a percentage |

A card payout could be added later as a second `PayoutRail` adapter (§5) if the
chosen PSP offers it. It shouldn't be the main mechanism.

## 2. Principle: don't hold bank details longer than it takes to pay

For each payee we keep only what we need to prove we paid the right person:

| Keep indefinitely (audit, FR-13) | Keep only until the payment has settled, then destroy |
|---|---|
| Provider's payee/beneficiary reference | Full account number and sort code |
| Last 4 digits of the account, masked sort code (`**-**-12`) | Account holder name as typed |
| Confirmation of Payee result (`match` / `close_match` / `no_match`) and when it ran | The claim-link token (only its hash is stored, §4) |
| Payment provider reference, amount, date | |

There are three ways to hold even less. In order of preference:

1. **The payout provider collects the details.** The claim page embeds or
   redirects to the provider's hosted form, and the provider hands back an
   opaque `payeeRef`. Our database, logs and Temporal history never see an
   account number. Payout APIs aimed at this use case (Modulr, ClearBank,
   TrueLayer Payouts, etc.) offer this. Which provider to use is a new decision
   (§9).
2. **The winner proves ownership through Open Banking (AIS).** The winner
   logs into their own bank. The provider returns the verified account and the
   holder name, and we get a `payeeRef`. This gives the strongest proof of
   ownership and saves typing. It fits "fully online" winners but not everyone.
3. **In-house form, as a fallback.** This covers cases where the society pays
   from its ordinary business bank account with no API (see §5, `manual_bank`
   rail). We collect the details ourselves and encrypt them at rest with a
   dedicated key: an AES-256-GCM helper like `apps/admin/src/secret-box.ts`,
   but with its own key, not the codec's or the TOTP one. We crypto-shred the
   row after settlement.

All three produce the same thing for the workflow: a `payeeRef` identifier.
**No bank details ever enter a workflow payload.** `sortcode`, `accountnumber`
and `bankaccount` are already on the `pii-guard.ts` forbidden list, and the
sort-code value pattern already catches them. The workflow only handles
identifiers.

## 3. The flow

```
settleDraw ──► prize row (pending_notification)
                  │ starts, ABANDON parent-close policy
                  ▼
        PrizeWorkflow  prize-<prizeId>   (task queue: payments)
                  │
  1. eligibility  ├─ member status: self_excluded / deceased (GAP-08) / quarantined → human_task
                  ├─ agent-attributed entry → unresolvedGap('GAP-47')           → human_task
                  │
  2. notify       ├─ issueClaimToken  (activity: random token, stores only its SHA-256)
                  ├─ sendNotification (activity: email / post via PrintHandoff / via_agent)
                  │    prize.status = notified
                  │
  3. wait         ├─ condition(details submitted)  ◄── Update `submit_payee` from apps/api
                  │    ├─ timers: reminders (GAP-46), re-issue token if expired
                  │    └─ claim deadline (GAP-28) → unclaimed path (unresolvedGap until set)
                  │
  4. verify       ├─ verifyPayee (activity: Confirmation of Payee)
                  │    ├─ match        → continue
                  │    ├─ close_match  → winner confirms the returned name, or re-enters
                  │    └─ no_match     → re-enter; after N attempts → human_task
                  │
  5. approve      ├─ amount ≥ threshold → human_task, two approvers (GAP-44 pattern)
                  │
  6. pay          ├─ submitPayout (activity, idempotency key = 'prize-payout:<prizeId>')
                  │    prize.status = payment_submitted
                  ├─ wait for settlement: provider webhook → signal, or poll, or bank feed recon
                  │    ├─ settled  → ledger: member_balance −amount / bank +amount
                  │    └─ returned → back to step 2 with a fresh link (account closed, etc.)
                  │
  7. close        ├─ prize.status = paid; "you've been paid" notification
                  └─ shredPayeeDetails (after the returns window, e.g. +5 working days)
```

### Why Temporal fits

This is the same shape as the rest of the system: most of the time is spent
waiting (days for the winner, possibly weeks until the claim deadline, an
unbounded wait for a human approver), and each wait has a timeout. One workflow
per prize, keyed by `prize-<prizeId>`, means:

- **A prize can't be paid twice.** Temporal refuses a second workflow with the
  same ID, and the payout call carries a deterministic idempotency key. The
  existing `prize_payout_idempotency_uniq` index is the third line of defence.
- Reminders and deadlines are **durable timers**, so no cron job has to scan the
  table.
- A payment that's returned, or details that need re-entering, is a loop in
  ordinary code, not a state-machine table.
- `getState` query → the admin console can show "awaiting details since 3 Oct,
  1 reminder sent" with no extra bookkeeping.

### Update rather than signal for form submission

The claim page should call the workflow with a **Temporal Update**
(`workflow.defineUpdate`), not a signal. An update has a validator and returns a
result, so the API can tell the winner "details received, we're checking them"
or "this claim has already been completed" synchronously, and a submission
against a finished or expired claim is rejected rather than silently queued.
The payload is `{ payeeRef, submittedVia, publicityConsent }`: identifiers
only.

## 4. The claim link, and why it isn't the only check

"You've won — click here and enter your bank details" is exactly what a
phishing email looks like. Anyone who controls or sees the winner's mailbox
could claim the money. So:

- **The token.** 32 random bytes, base64url. Generated in an activity, never in
  workflow code (the determinism lint would reject it anyway). The token is sent
  only in the email; we store only its SHA-256. It's single-use, expires (default
  14 days, re-issued by the workflow if it lapses), and is bound to one
  `prize_id`. It never goes into workflow history.
- **The link opens the member portal on its known domain**, not a third-party
  link shortener or a tracking redirect.
- **A second factor is required.** The link identifies the claim; it doesn't
  authenticate the claimant:
  - online members: log in to the existing member portal (`apps/api/src/auth.ts`);
  - members without a login: one-time code by SMS to the phone number on
    record, or a knowledge check against data we already hold (member number +
    date of birth + postcode). The spec needs to choose.
- **The email contains no amount and no personal data** beyond "you have a
  prize from draw N". It says that QOSFC will never ask for a password or card
  number, and it tells the winner how to reach the portal without clicking.
- **No email address (GAP-05).** Send a letter through `PrintHandoff` with a
  short claim code that the winner types at the portal. The flow is the same
  from there. For winners who can't use the portal, an admin can enter the
  details over the phone. This needs an audited admin action and a second
  approver.
- **Details are locked once submitted.** Changing them afterwards needs an admin
  action and restarts verification. This is the classic payment-diversion attack.
- **Rate-limit and lock out** repeated failed second-factor attempts per token.

The claim page also collects the answers the winner has to give anyway:
publicity consent (GAP-29), and confirmation that they are 18+ (GAP-37 / FR-11.2)
where `date_of_birth` is null.

## 5. Ports and adapters

Two new ports in `packages/ports`, following the existing pattern: failure
semantics belong to the port, and adapters map errors onto
`TransientProviderError` / `PermanentProviderError`.

```ts
// packages/ports/src/payee-verification.ts
export interface PayeeVerifier {
  readonly providerName: string;
  /** Provider-hosted capture (option 1/2). Returns a URL to redirect to, or null if unsupported. */
  startPayeeCapture(req: { idempotencyKey: IdempotencyKey; prizeRef: string; returnUrl: string }):
    Promise<{ captureUrl: string | null }>;
  /** Confirmation of Payee against a payeeRef. Never takes raw details as arguments from workflow code. */
  verify(payeeRef: string): Promise<
    | { result: 'match' }
    | { result: 'close_match'; suggestedName: string }   // shown to the winner, never logged
    | { result: 'no_match' | 'unavailable'; reasonCode: string }
  >;
  forget(payeeRef: string): Promise<void>;               // crypto-shred / delete at provider
}

// packages/ports/src/payout-rail.ts
export interface PayoutRail {
  readonly providerName: string;
  submitPayout(req: { idempotencyKey: IdempotencyKey; payeeRef: string; amountPence: PenceString; reference: string }):
    Promise<{ payoutRef: string; expectedBy: string }>;
  getPayout(payoutRef: string): Promise<
    | { status: 'pending' }
    | { status: 'settled'; settledAt: string }
    | { status: 'returned'; reasonCode: string; reason: string }
  >;
}
```

Adapters, selected in `apps/worker/src/composition-root.ts` as the other ports
are:

| Adapter | Where | What it does |
|---|---|---|
| `sandbox` | `adapters-sandbox` + `services/sandbox-providers` | Hosted capture page, CoP with deterministic outcomes by account number (for e2e: `…0000` match, `…0001` close match, `…0002` no match), payouts that settle after a configurable delay, and some that are returned |
| `manual_bank` | `adapters-live` | For a society with only an ordinary business account. `submitPayout` generates a bulk-payment file (FPS/Bacs CSV in the bank's upload format) and opens a `human_task` for the treasurer to upload and authorise it in online banking. The bank does CoP when the payee is set up. Settlement is confirmed by the existing bank-feed reconciliation matching the outgoing debit. Needs option 3 storage |
| `api_provider` | `adapters-live` | A payout API (options 1/2): hosted capture, CoP, FPS payout, webhooks. Shape-only until the provider is chosen, like `card-portal.ts` today |

`manual_bank` needs no new commercial relationship and can go live first.
`api_provider` removes the stored-details window and the manual step.

## 6. Data model — migration `0013_prize_payout.sql`

```sql
ALTER TYPE prize_status ADD VALUE 'awaiting_details' AFTER 'notified';
ALTER TYPE prize_status ADD VALUE 'verifying'        AFTER 'awaiting_details';
ALTER TYPE prize_status ADD VALUE 'payment_submitted' AFTER 'claimed';
ALTER TYPE prize_status ADD VALUE 'returned'         AFTER 'payment_submitted';

CREATE TABLE prize_claim_token (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prize_id     uuid NOT NULL REFERENCES prize(id),
  token_sha256 bytea NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  failed_second_factor_attempts int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- At most one live token per prize.
CREATE UNIQUE INDEX prize_claim_token_live_uniq ON prize_claim_token (prize_id) WHERE used_at IS NULL;

CREATE TABLE prize_payee (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prize_id          uuid NOT NULL REFERENCES prize(id),
  provider          text NOT NULL,
  payee_ref         text NOT NULL,            -- provider's id, or our own for manual_bank
  account_last4     text NOT NULL,
  sort_code_masked  text NOT NULL,
  details_enc       bytea,                    -- manual_bank only; NULL once shredded
  cop_result        text,
  cop_checked_at    timestamptz,
  submitted_via     text NOT NULL,            -- 'portal' | 'claim_code' | 'admin_phone'
  shredded_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shredded_means_gone CHECK (shredded_at IS NULL OR details_enc IS NULL)
);

CREATE TABLE prize_payout (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prize_id        uuid NOT NULL REFERENCES prize(id),
  prize_payee_id  uuid NOT NULL REFERENCES prize_payee(id),
  attempt         int NOT NULL,
  idempotency_key text NOT NULL UNIQUE,       -- 'prize-payout:<prize_id>:<attempt>'
  provider_ref    text,
  status          text NOT NULL,              -- submitted | settled | returned
  return_reason   text,
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  settled_at      timestamptz,
  UNIQUE (prize_id, attempt)
);
-- Only one payout per prize may ever be settled.
CREATE UNIQUE INDEX prize_payout_one_settled ON prize_payout (prize_id) WHERE status = 'settled';
```

Grant `UPDATE (details_enc, shredded_at)` on `prize_payee` narrowly, in the same
style as the `0007` append-only grants, so the application role can shred but
can't rewrite history. Add `config_version` columns:
`payout_approval_threshold_pence`, `claim_token_ttl_days`,
`payout_reminder_days int[]`.

The idempotency key includes the attempt number so that a *returned* payment can
legitimately be retried to a new account. The partial unique index is what
still guarantees a single settled payment.

**Ledger.** On settlement, one balanced transaction: `member_balance −amount`,
`bank +amount`, with `prize_id` set (the FK already exists). On return, nothing
is posted, because nothing was posted at submission; post at settlement, not at
submission.

## 7. Code layout

| Where | What |
|---|---|
| `packages/workflows/src/prize.ts` | `PrizeWorkflow`, `submitPayee` update, `payoutApproval` signal, `getState` query |
| `packages/activities/src/prize/*` | `checkPrizeEligibility`, `issueClaimToken`, `sendPrizeNotification`, `verifyPayee`, `submitPayout`, `awaitPayoutSettlement`, `postPayoutLedger`, `shredPayee` |
| `packages/activities/src/draw/settle.ts` | After commit, start `PrizeWorkflow` per new prize (or return prize IDs to `DrawWorkflow` and start them as ABANDON children, which keeps it replay-visible) |
| `apps/api` | `GET /claim/:token` → second factor → capture (provider-hosted redirect, or our form) → `submitPayee` update. `POST /webhooks/payout` → signature-checked → signal the prize workflow |
| `apps/admin` | Prize list by status, payout approval tasks, "re-send claim link", phone-assisted entry (dual-approved), manual-bank file download |
| `services/sandbox-providers` | Hosted capture page, CoP simulator, payout simulator |

## 8. Build order

1. **Ports and sandbox adapters**, contract tests shared with the live adapters.
2. **`PrizeWorkflow` against the sandbox**, with workflow tests using the
   time-skipping test environment: happy path, CoP close/no match, reminder and
   expiry, returned payment, two-approver gate, duplicate start rejected.
3. **Claim page and token handling** in `apps/api`, email via mailpit.
4. **Migration 0013 and ledger posting**, with integration tests proving a
   prize can't settle twice and the books balance.
5. **`manual_bank` adapter.** First real-money route, needs only the bank's
   bulk-upload format (same approach as `real-export-csv-format.ts`).
6. **`api_provider` adapter** once a provider is chosen; then switch the default
   and retire stored details.

## 9. Decisions needed

| Gap | Question | Suggested default to put to the client |
|---|---|---|
| GAP-30 | Payment mechanism | Bank transfer (FPS). Card payout only as a later optional adapter |
| **new** | Payout rail: manual bulk upload from the society's account, or a payout API provider (and which) | Start `manual_bank`; evaluate a provider in parallel |
| **new** | Second factor for claimants with no portal login: SMS OTP or knowledge check | Portal login where one exists; knowledge check otherwise |
| GAP-28 | Claim period and what happens to unclaimed prizes | Without it, the workflow opens a `human_task` at the deadline instead of guessing |
| GAP-46 | Reminder cadence and when to give up on a channel | e.g. reminders on days 3, 7 and 14, then switch to post |
| GAP-44 | Amount above which a payout needs two approvers | Every payout, while volumes are this low. It's one click per week |
| GAP-29 | Winner publicity consent | Captured on the claim page, opt-in, default no |
| GAP-47 ⛔ | Agent-attributed winning tickets: who is paid | Blocks in step 1 until decided. No payout is made to an agent by default |
| GAP-08 | Deceased winners / estates | `human_task`; manual process |
| TG-07 | How long to keep payee *audit* data (not the bank details, which go at settlement) | Same as other financial records |
