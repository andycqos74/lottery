import { describe, expect, it } from 'vitest';
import { FailureThrottle } from './failure-throttle.js';

describe('FailureThrottle (#44)', () => {
  const throttle = () => new FailureThrottle({ maxFailures: 3, windowMs: 1000 });

  it('locks a key at the limit, and says for how long', () => {
    const t = throttle();
    t.recordFailure('a', 0);
    t.recordFailure('a', 100);
    expect(t.retryAfterMs('a', 200)).toBe(0);
    t.recordFailure('a', 200);
    expect(t.retryAfterMs('a', 300)).toBe(700); // the first failure leaves the window at 1000
    expect(t.retryAfterMs('b', 300)).toBe(0);
  });

  it('forgets failures older than the window', () => {
    const t = throttle();
    for (const at of [0, 10, 20]) t.recordFailure('a', at);
    expect(t.retryAfterMs('a', 1010)).toBe(0); // the failure at 0 has left the window
    expect(t.retryAfterMs('a', 1020)).toBe(0);
    t.recordFailure('a', 1021);
    expect(t.retryAfterMs('a', 1022)).toBe(0); // only one failure in the window now
  });

  it('clears an account on success', () => {
    const t = throttle();
    for (const at of [0, 10, 20]) t.recordFailure('a', at);
    t.clear('a');
    expect(t.retryAfterMs('a', 30)).toBe(0);
  });
});
