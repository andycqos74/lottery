/**
 * Failure semantics belong to the PORT, not the adapter.
 *
 * Tech spec §8.1 assigns a retry policy per activity class, and that policy is
 * only correct if "retryable" means the same thing whichever provider is behind
 * the interface. If each adapter decided for itself, swapping GoCardless for a
 * bureau would silently change how a failed collection behaves.
 *
 * So every adapter — sandbox and live alike — must map its provider's errors onto
 * these two, and the contract test suite checks that it does.
 */

/** Worth trying again: a timeout, a 503, a rate limit, a bank outage. */
export class TransientProviderError extends Error {
  override readonly name = 'TransientProviderError';
  readonly nonRetryable = false;
  constructor(message: string, readonly provider: string, options?: ErrorOptions) {
    super(`[${provider}] ${message}`, options);
  }
}

/**
 * Never worth trying again: a declined card, a rejected mandate, a validation
 * failure, an invalid account. FR-14.2 requires these to trigger the business
 * path immediately rather than burning a retry budget first.
 */
export class PermanentProviderError extends Error {
  override readonly name = 'PermanentProviderError';
  readonly nonRetryable = true;
  constructor(
    message: string,
    readonly provider: string,
    readonly reasonCode: string,
    options?: ErrorOptions,
  ) {
    super(`[${provider}] ${message} (${reasonCode})`, options);
  }
}

export const isTransient = (e: unknown): e is TransientProviderError =>
  e instanceof Error && e.name === 'TransientProviderError';
export const isPermanent = (e: unknown): e is PermanentProviderError =>
  e instanceof Error && e.name === 'PermanentProviderError';

/**
 * Every money-moving call carries one (T-8.2).
 *
 * Deterministic, derived from workflow state — `prize_id`, `cycle_key`,
 * `<draw_id>:<member_number>:<slot>` — never generated at call time. A random key
 * would defeat the purpose: the retry would carry a different key and pay twice.
 */
export type IdempotencyKey = string & { readonly __brand: 'IdempotencyKey' };

export function idempotencyKey(value: string): IdempotencyKey {
  if (!value || value.length > 200) {
    throw new RangeError(`Idempotency key must be 1..200 characters, got ${value.length}.`);
  }
  return value as IdempotencyKey;
}
