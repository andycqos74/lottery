/**
 * GAP-33, resolved: CSV upload, not Open Banking (left for future
 * consideration) and not continued OCR — confirmed by Andy Cowan.
 *
 * Implements the `BankFeed` port over a drop-folder of files uploaded through
 * the admin console (`apps/admin`'s `/bank-statements` route writes them
 * here). There is no live connection to poll — a person uploads a file — so
 * "listing statements" means scanning the folder, and "extracting credits"
 * means re-reading and re-parsing the one file already named by that listing.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BankCredit, BankFeed, StatementSummary } from '@qosfc/ports';
import { parseCanonicalStatementCsv } from './csv-format.js';

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
      const { summary } = parseCanonicalStatementCsv(text);
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
    const { rows } = parseCanonicalStatementCsv(text);
    const fromIndex = request.fromIndex ?? 0;
    return { credits: rows.slice(fromIndex) };
  }
}
