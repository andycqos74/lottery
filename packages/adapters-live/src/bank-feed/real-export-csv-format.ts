/**
 * The bank's own "TransactionHistory" CSV export (GAP-33, B-10 — the real
 * column mapping, once a sample finally existed).
 *
 * Header: TransactionDate,ValueDate,Account,AccountName,Debit-Credit,
 * TransactionCode,TransactionType,Amount,Description,Reference,Source,Currency
 *
 * Two things make this unlike `csv-format.ts`'s invented schema, and unlike a
 * well-behaved CSV generally:
 *
 * 1. `Description` contains unescaped, unquoted commas of its own (e.g.
 *    "FPS, Justice Js& Mrs E, 1990"), so a row can have more than 12 fields.
 *    There is no per-row way to tell where Description ends other than
 *    counting from both ends: the 8 columns before it and the 3 after it
 *    (Reference, Source, Currency) are fixed-width; whatever is left in the
 *    middle — however many commas it contains — is Description.
 * 2. There is no opening/closing balance anywhere in this export (it is a
 *    transaction history, not a statement), so FR-5.8.2 continuity cannot be
 *    verified against it. `parseRealExportCsv` returns a summary with no
 *    balance fields at all; `ingestNewStatements` treats that as "continuity
 *    not checked" rather than a failure, at Andy Cowan's explicit direction —
 *    re-introducing it is future-phase work, contingent on the bank offering
 *    an export that actually carries a balance.
 *
 * Because there is no statement number either, per-transaction identity comes
 * from `externalId` (a hash of the row's own fields) rather than from a
 * `statement:index` pair — the whole point being that re-uploading an export
 * whose date range overlaps a previous one must not double-count the
 * transactions the two exports share.
 */
import { createHash } from 'node:crypto';
import type { BankCredit } from '@qosfc/ports';

export interface ParsedRealExportBatch {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly rows: readonly BankCredit[];
}

export class RealExportCsvFormatError extends Error {}

const REQUIRED_HEADER_COLUMNS = [
  'transactiondate',
  'valuedate',
  'account',
  'accountname',
  'debit-credit',
  'transactioncode',
  'transactiontype',
  'amount',
  'description',
  'reference',
  'source',
  'currency',
] as const;

const PREFIX_COLUMN_COUNT = 8; // TransactionDate .. Amount
const SUFFIX_COLUMN_COUNT = 3; // Reference, Source, Currency

/** Recognises the export by its header, without needing a caller to say which format a file is. */
export function looksLikeRealExportCsv(headerLine: string): boolean {
  const header = headerLine.split(',').map((h) => h.trim().toLowerCase());
  return REQUIRED_HEADER_COLUMNS.every((c) => header.includes(c));
}

function toIsoDate(raw: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw.trim());
  if (!m) throw new RealExportCsvFormatError(`TransactionDate must be YYYYMMDD, got "${raw}".`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Decimal pounds ("-25", "4.34", "8.68") to a whole number of pence, without floating point. */
function poundsToPence(raw: string): string {
  const trimmed = raw.trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!m) throw new RealExportCsvFormatError(`Amount must be a decimal pounds value, got "${raw}".`);
  const [, sign, whole, fraction = ''] = m as unknown as [string, string, string, string | undefined];
  const pence = fraction.padEnd(2, '0');
  return `${sign}${(BigInt(whole) * 100n + BigInt(pence)).toString()}`;
}

function stripQuotes(raw: string): string {
  const t = raw.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

/** Everything before the last comma-separated segment, e.g. "FPS, Justice Js& Mrs E, 1990" -> "FPS, Justice Js& Mrs E". */
function nameFromDescription(description: string): string | undefined {
  const idx = description.lastIndexOf(',');
  if (idx < 0) return undefined;
  const name = description.slice(0, idx).replace(/^FPS,\s*/i, '').trim();
  return name.length > 0 ? name : undefined;
}

export function parseRealExportCsv(text: string): ParsedRealExportBatch {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 1) {
    throw new RealExportCsvFormatError('Empty file.');
  }
  const header = lines[0]!.split(',').map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_HEADER_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new RealExportCsvFormatError(`Header row is missing column(s): ${missing.join(', ')}. Got: ${lines[0]}`);
  }

  const rows: BankCredit[] = [];
  const dates: string[] = [];

  lines.slice(1).forEach((line, rowIndex) => {
    // Deliberately NOT trimmed before the split: Description is whatever sits
    // between the fixed prefix and suffix, commas and all, and trimming each
    // raw field first would eat the space that follows every one of those
    // internal commas (turning "FPS, Justice Js& Mrs E, 1990" into
    // "FPS,Justice Js& Mrs E,1990"). Only the composed Description, and the
    // genuinely single-valued fields, are trimmed — each on its own, below.
    const rawFields = line.split(',');
    if (rawFields.length < PREFIX_COLUMN_COUNT + SUFFIX_COLUMN_COUNT) {
      throw new RealExportCsvFormatError(`Row ${rowIndex + 2}: expected at least ${PREFIX_COLUMN_COUNT + SUFFIX_COLUMN_COUNT} columns, got ${rawFields.length}.`);
    }
    const suffixStart = rawFields.length - SUFFIX_COLUMN_COUNT;
    const prefixFields = rawFields.slice(0, PREFIX_COLUMN_COUNT).map((f) => f.trim());
    const [transactionDate, , , , debitCredit, , transactionType, amount] = prefixFields as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const description = rawFields.slice(PREFIX_COLUMN_COUNT, suffixStart).join(',').trim();
    const [reference, , currency] = rawFields.slice(suffixStart).map((f) => f.trim()) as unknown as [string, string, string];

    const valueDate = toIsoDate(transactionDate);
    const amountPenceUnsigned = poundsToPence(amount);
    const isCredit = debitCredit.trim().toUpperCase() === 'CR';
    // The Debit-Credit column and Amount's own sign must agree — if they don't,
    // something about this row was mis-split, and guessing which one to trust
    // would silently misroute real money.
    if (isCredit === amountPenceUnsigned.startsWith('-')) {
      throw new RealExportCsvFormatError(
        `Row ${rowIndex + 2}: Debit-Credit ("${debitCredit}") disagrees with Amount's sign ("${amount}").`,
      );
    }
    if (currency && currency.trim().toUpperCase() !== 'GBP') {
      throw new RealExportCsvFormatError(`Row ${rowIndex + 2}: only GBP is supported, got "${currency}".`);
    }

    dates.push(valueDate);
    const trimmedReference = stripQuotes(reference);
    const name = description ? nameFromDescription(description) : undefined;
    const externalId = `csv-real:${createHash('sha256')
      .update(`${transactionDate}|${debitCredit}|${amountPenceUnsigned}|${description}|${trimmedReference}`)
      .digest('hex')
      .slice(0, 40)}`;

    rows.push({
      externalId,
      valueDate,
      description,
      typeRaw: transactionType,
      amountPence: amountPenceUnsigned,
      isCredit,
      ...(trimmedReference ? { extractedReference: trimmedReference } : {}),
      ...(name ? { extractedName: name } : {}),
    });
  });

  dates.sort();
  return {
    periodStart: dates[0] ?? '',
    periodEnd: dates[dates.length - 1] ?? '',
    rows,
  };
}
