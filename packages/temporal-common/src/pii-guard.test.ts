import { describe, expect, it, vi } from 'vitest';
import { assertIdentifiersOnly, defaultGuardMode, findPiiViolations, PiiInPayloadError } from './pii-guard.js';

describe('T-1.3 — identifier-only payload discipline', () => {
  it('accepts an identifier-only payload', () => {
    expect(findPiiViolations({ memberId: 'a3f1-...', drawId: 'b7c2', prizeDrawNo: 1002, amountPence: '200' })).toEqual(
      [],
    );
  });

  it.each([
    [{ surname: 'Pattie' }, 'surname'],
    [{ member: { address1: '1 The Street' } }, 'address1'],
    [{ email: 'a@b.test' }, 'email'],
    [{ sortCode: '12-34-56' }, 'sortCode'],
    [{ totpSecret: 'JBSWY3DP' }, 'totpSecret'],
  ])('flags %j by field name', (payload, field) => {
    const violations = findPiiViolations(payload);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.path).toContain(field);
  });

  it.each([
    ['a UK postcode', { note: 'lives at DG1 1AA' }, 'postcode'],
    ['an email in free text', { note: 'contact me at a@b.test' }, 'email'],
    ['a sort code', { reference: 'paid via 12-34-56' }, 'sort code'],
    ['a card number', { reference: '4111 1111 1111 1111' }, 'card number'],
  ])('flags %s by value even when the field name is innocent', (_label, payload, expected) => {
    const violations = findPiiViolations(payload);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.reason.includes(expected))).toBe(true);
  });

  it('finds violations nested inside arrays', () => {
    const violations = findPiiViolations({ members: [{ id: 'ok' }, { id: 'ok', surname: 'Henry' }] });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.path).toBe('$.members[1].surname');
  });

  it('throws in development, so the mistake is fixed before it ships', () => {
    expect(() => assertIdentifiersOnly({ surname: 'Pattie' }, 'DrawWorkflow input', { mode: 'throw' })).toThrow(
      PiiInPayloadError,
    );
  });

  it('reports but does not throw in production — a live draw must not die over a log line', () => {
    const onViolation = vi.fn();
    expect(() =>
      assertIdentifiersOnly({ surname: 'Pattie' }, 'DrawWorkflow input', { mode: 'report', onViolation }),
    ).not.toThrow();
    expect(onViolation).toHaveBeenCalledOnce();
  });

  it('chooses its mode from the environment', () => {
    expect(defaultGuardMode('production')).toBe('report');
    expect(defaultGuardMode('development')).toBe('throw');
    expect(defaultGuardMode('test')).toBe('throw');
  });
});
