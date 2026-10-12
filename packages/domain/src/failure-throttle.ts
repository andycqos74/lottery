/**
 * Login throttling (#44, F-5 in docs/TEST_PLAN.md).
 *
 * Counts FAILED attempts per key — an account, a client address — in a
 * sliding window, and reports a key as locked once it reaches the limit.
 * Successful logins are not counted, so a member logging in often is never
 * slowed down; only guessing is.
 *
 * Held in the process's memory: each app runs as one instance, and a restart
 * forgetting the counts costs an attacker a restart, not the limit. The clock
 * is passed in — this package is imported by workflow code and reads no clock.
 */
export interface FailureThrottleOptions {
  /** Failures within the window that lock the key. */
  readonly maxFailures: number;
  readonly windowMs: number;
}

export class FailureThrottle {
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly options: FailureThrottleOptions) {}

  /** Milliseconds until the key may try again, or 0 if it is not locked. */
  retryAfterMs(key: string, nowMs: number): number {
    const recent = this.recent(key, nowMs);
    if (recent.length < this.options.maxFailures) return 0;
    return recent[recent.length - this.options.maxFailures]! + this.options.windowMs - nowMs;
  }

  recordFailure(key: string, nowMs: number): void {
    this.failures.set(key, [...this.recent(key, nowMs), nowMs]);
    if (this.failures.size > 10_000) this.prune(nowMs);
  }

  /** A successful login clears the account's count. */
  clear(key: string): void {
    this.failures.delete(key);
  }

  private recent(key: string, nowMs: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter((t) => t > nowMs - this.options.windowMs);
    if (kept.length === 0) this.failures.delete(key);
    return kept;
  }

  private prune(nowMs: number): void {
    for (const key of [...this.failures.keys()]) this.recent(key, nowMs);
  }
}

/** The limits both login forms use unless the environment overrides them. */
export const LOGIN_THROTTLE_DEFAULTS = {
  /** Wrong passwords (or MFA codes) for one account, per window. */
  perAccount: { maxFailures: 10, windowMs: 15 * 60 * 1000 },
  /** Wrong passwords from one client address, across all accounts, per window. */
  perAddress: { maxFailures: 50, windowMs: 15 * 60 * 1000 },
} as const;
