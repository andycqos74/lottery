-- 0016_elavon_payment_sessions — card payments through the Elavon Payment
-- Gateway (EPG), GitHub #12 / GAP-09.
--
-- EPG only issues a payment-session ID after the session (and its return URL)
-- has been created, so the return URL carries OUR reference instead and this
-- table maps it back to EPG's order and session — the same approach the
-- client's Wix EPG integration uses. Holds no card data (T-9.1): card details
-- are only ever entered on Elavon's hosted page.

CREATE TABLE elavon_payment_session (
  reference        text PRIMARY KEY,            -- ours; also EPG invoiceNumber (max 25 chars)
  idempotency_key  text NOT NULL UNIQUE,
  epg_order_id     text NOT NULL,
  epg_session_id   text NOT NULL UNIQUE,
  redirect_url     text NOT NULL,
  amount_pence     bigint NOT NULL CHECK (amount_pence > 0),
  currency         text NOT NULL,
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- A refund request retried with the same idempotency key returns the refund
-- already made instead of refunding twice.
CREATE TABLE elavon_refund (
  idempotency_key  text PRIMARY KEY,
  sale_ref         text NOT NULL,
  refund_ref       text NOT NULL,
  method           text NOT NULL CHECK (method IN ('void','refund')),
  amount_pence     bigint NOT NULL CHECK (amount_pence > 0),
  created_at       timestamptz NOT NULL DEFAULT now()
);
