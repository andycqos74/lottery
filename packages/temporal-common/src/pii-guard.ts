/**
 * Identifier-only payload discipline (T-1.3, T-9.5, NFR-6).
 *
 * "Workflow inputs and signals carry identifiers, never personal data."
 *
 * The lint rules stop the obvious cases at build time. This is the runtime
 * backstop for what lint cannot see: a `Record<string, unknown>` assembled at
 * runtime, a spread of a database row, an error message that happens to contain
 * a member's address.
 *
 * It is deliberately a DETECTOR, not a redactor. Silently stripping a field would
 * hide a design mistake and produce a workflow that behaves differently in
 * production than in test. In development it throws so the mistake is fixed; in
 * production it records a violation and lets the business process continue,
 * because dropping a live draw is worse than one over-broad payload that the
 * codec has, in any case, encrypted.
 */

/** Field names that must never appear in a workflow or activity payload. */
const FORBIDDEN_KEYS = new Set([
  'forename', 'surname', 'firstname', 'lastname', 'fullname', 'name',
  'address', 'address1', 'address2', 'address3', 'addressline1', 'postcode', 'postalcode', 'zip',
  'email', 'emailaddress', 'telephone', 'phone', 'mobile',
  'dateofbirth', 'dob',
  'sortcode', 'accountnumber', 'iban', 'bankaccount',
  'pan', 'cardnumber', 'cvv', 'cvc', 'expiry',
  'password', 'passwordhash', 'totpsecret', 'secret', 'apikey', 'token',
]);

/** Values that look like personal data whatever they are called. */
const VALUE_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: 'UK postcode', re: /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i },
  { name: 'email address', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/ },
  { name: 'UK sort code', re: /\b\d{2}-\d{2}-\d{2}\b/ },
  { name: 'card number', re: /\b(?:\d[ -]?){13,19}\b/ },
  { name: 'IBAN', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/ },
];

export interface PiiViolation {
  readonly path: string;
  readonly reason: string;
}

/** Walk a payload and report every identifier-only violation found. */
export function findPiiViolations(value: unknown, path = '$', depth = 0): PiiViolation[] {
  if (depth > 12 || value === null || value === undefined) return [];

  if (typeof value === 'string') {
    return VALUE_PATTERNS.filter((p) => p.re.test(value)).map((p) => ({
      path,
      reason: `value looks like a ${p.name}`,
    }));
  }

  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findPiiViolations(v, `${path}[${i}]`, depth + 1));
  }

  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) => {
      const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      const here = `${path}.${key}`;
      if (FORBIDDEN_KEYS.has(normalised)) {
        return [{ path: here, reason: `"${key}" is personal data and must not enter a workflow payload` }];
      }
      return findPiiViolations(v, here, depth + 1);
    });
  }

  return [];
}

export type PiiGuardMode = 'throw' | 'report';

export interface PiiGuardOptions {
  readonly mode: PiiGuardMode;
  readonly onViolation?: (violations: readonly PiiViolation[], context: string) => void;
}

export class PiiInPayloadError extends Error {
  override readonly name = 'PiiInPayloadError';
  constructor(readonly violations: readonly PiiViolation[], context: string) {
    super(
      `T-1.3 violated in ${context}: workflow payloads carry identifiers, never personal data. ` +
        violations.map((v) => `${v.path} — ${v.reason}`).join('; ') +
        `. Pass an id and let an activity fetch what it needs from PostgreSQL.`,
    );
  }
}

/**
 * Assert a payload is identifier-only.
 *
 * @param context Where this was called from, for the error and the metric.
 */
export function assertIdentifiersOnly(value: unknown, context: string, options: PiiGuardOptions): void {
  const violations = findPiiViolations(value);
  if (violations.length === 0) return;

  options.onViolation?.(violations, context);
  if (options.mode === 'throw') throw new PiiInPayloadError(violations, context);
}

/**
 * Throw in development and test; report in production.
 *
 * A live draw must not fail because a log line contained a postcode, but the
 * violation must not be invisible either — it goes to the metric and the logs,
 * and the codec has encrypted the payload regardless.
 */
export function defaultGuardMode(nodeEnv = process.env['NODE_ENV']): PiiGuardMode {
  return nodeEnv === 'production' ? 'report' : 'throw';
}
