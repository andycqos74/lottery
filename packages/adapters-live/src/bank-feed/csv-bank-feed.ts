/**
 * GAP-33, resolved: CSV upload, not Open Banking (left for future
 * consideration) and not continued OCR — confirmed by Andy Cowan.
 *
 * Implements the `BankFeed` port over a drop-folder of files uploaded through
 * the admin console (`apps/admin`'s `/bank-statements` route writes them
 * here). There is no live connection to poll — a person uploads a file — so
 * "listing statements" means scanning the folder, and "extracting credits"
 * means re-reading and re-parsing the one file already named by that listing.
 *
 * Two file shapes are accepted, detected by header rather than by a caller
 * having to say which one a file is: the canonical `#statement ...` schema
 * (`csv-format.ts`, used by tests and any hand-built fixture), and the bank's
 * own "TransactionHistory" export (`real-export-csv-format.ts`, B-10). The
 * real export has no statement number or balance, so its `statementNumber` is
 * derived from a hash of the file's own bytes — stable across repeated
 * `listStatements()` calls on the same file, which is what lets "already
 * ingested" (keyed on that number) work exactly as it does for the canonical
 * format, even though the number itself carries no meaning from the bank.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BankCredit, BankFeed, StatementSummary } from '@qosfc/ports';
import { parseCanonicalStatementCsv } from './csv-format.js';
import { looksLikeRealExportCsv, parseRealExportCsv } from './real-export-csv-format.js';

/** A statement number synthesised from file content — see the module comment. Kept within Postgres's int4 range. */
function contentStatementNumber(text: string): number {
  const digest = createHash('sha256').update(text).digest();
  return digest.readUInt32BE(0) % 2_000_000_000;
}

function parseAny(text: string): { summary: Omit<StatementSummary, 'source' | 'sourceRef'>; rows: readonly BankCredit[] } {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  if (firstLine.startsWith('#statement')) {
    return parseCanonicalStatementCsv(text);
  }
  if (looksLikeRealExportCsv(firstLine)) {
    const { periodStart, periodEnd, rows } = parseRealExportCsv(text);
    return { summary: { statementNumber: contentStatementNumber(text), periodStart, periodEnd }, rows };
  }
  throw new Error(`Unrecognised bank statement CSV — header did not match a known format. First line: "${firstLine}"`);
}

export class CsvBankFeed implements BankFeed {
  readonly providerName = 'live:csv-upload';
  readonly source = 'csv' as const;

  constructor(private readonly uploadDir: string) {}

  async listStatements(request: { readonly since?: number; readonly limit?: number }): Promise<readonly StatementSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.uploadDir);
    } catch {
      return [];
    }
    const csvFiles = names.filter((n) => n.endsWith('.csv')).sort();

    const summaries: StatementSummary[] = [];
    for (const name of csvFiles) {
      const text = await readFile(join(this.uploadDir, name), 'utf8');
      const { summary } = parseAny(text);
      if (request.since !== undefined && summary.statementNumber <= request.since) continue;
      summaries.push({ ...summary, source: this.source, sourceRef: name });
    }
    summaries.sort((a, b) => a.statementNumber - b.statementNumber);
    return request.limit !== undefined ? summaries.slice(0, request.limit) : summaries;
  }

  async extractCredits(request: {
    readonly statementNumber: number;
    readonly fromIndex?: number;
  }): Promise<{ readonly credits: readonly BankCredit[]; readonly nextIndex?: number }> {
    const statements = await this.listStatements({});
    const target = statements.find((s) => s.statementNumber === request.statementNumber);
    if (!target) {
      throw new Error(`No uploaded CSV statement numbered ${request.statementNumber}.`);
    }
    const text = await readFile(join(this.uploadDir, target.sourceRef), 'utf8');
    const { rows } = parseAny(text);
    const fromIndex = request.fromIndex ?? 0;
    return { credits: rows.slice(fromIndex) };
  }
}
