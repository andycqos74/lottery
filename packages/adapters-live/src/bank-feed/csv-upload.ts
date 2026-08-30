/**
 * GAP-33, resolved for now (client decision, see docs/gap-register.md): bank
 * statements arrive as a manually-uploaded CSV export, not Open Banking or OCR.
 * Both of those stay live options for future development — the port already
 * carries a per-transaction `confidence` specifically so the matching engine
 * does not need rewriting when one of them replaces this.
 *
 * "Manual upload" here means: an operator drops the bank's CSV export into a
 * directory (`uploadsDir`), one file per statement. There is no object store
 * integration yet (T-9.5 wants the bytes kept out of the database and workflow
 * payloads either way) — `sourceRef` records the filename, which is enough to
 * find the file on this host. A real object store is a natural next step, not
 * a rewrite: only `readRows`/`findFile` would change.
 *
 * Column shape assumed (common to UK current-account CSV exports): Date,
 * Description, Type, Amount, Balance — see `parseRow`. A bank whose export
 * differs needs a new column mapping here, not a new adapter.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PermanentProviderError, type BankCredit, type BankFeed, type StatementSummary } from '@qosfc/ports';

const PROVIDER = 'live:csv-upload';

export interface CsvUploadConfig {
  /** Directory an operator uploads exported CSV files into. One file per statement. */
  readonly uploadsDir: string;
}

interface ParsedRow {
  readonly date: string;
  readonly description: string;
  readonly typeRaw: string;
  readonly reference?: string;
  readonly amountPence: bigint;
  readonly isCredit: boolean;
  readonly balancePence?: bigint;
}

export class CsvUploadBankFeed implements BankFeed {
  readonly providerName = PROVIDER;
  readonly source = 'csv' as const;

  constructor(private readonly config: CsvUploadConfig) {}

  async listStatements(request: {
    readonly since?: number;
    readonly limit?: number;
  }): Promise<readonly StatementSummary[]> {
    const files = await this.csvFiles();
    const summaries: StatementSummary[] = [];

    for (const file of files) {
      const statementNumber = statementNumberFromFilename(file);
      if (statementNumber === undefined) continue;
      if (request.since !== undefined && statementNumber <= request.since) continue;

      const rows = await this.readRows(file);
      if (rows.length === 0) continue;
      const first = rows[0]!;
      const last = rows[rows.length - 1]!;

      summaries.push({
        statementNumber,
        periodStart: first.date,
        periodEnd: last.date,
        // Opening = the balance BEFORE the first row's movement; closing = the
        // last row's own running balance. A CSV with no balance column simply
        // cannot state these — 0 is honest, not a guess.
        openingBalancePence: (first.balancePence !== undefined
          ? (first.isCredit ? first.balancePence - first.amountPence : first.balancePence + first.amountPence)
          : 0n
        ).toString(),
        closingBalancePence: (last.balancePence ?? 0n).toString(),
        source: 'csv',
        sourceRef: file,
      });
    }

    summaries.sort((a, b) => a.statementNumber - b.statementNumber);
    return request.limit !== undefined ? summaries.slice(0, request.limit) : summaries;
  }

  async extractCredits(request: {
    readonly statementNumber: number;
    readonly fromIndex?: number;
  }): Promise<{ readonly credits: readonly BankCredit[]; readonly nextIndex?: number }> {
    const file = await this.findFile(request.statementNumber);
    const rows = await this.readRows(file);
    const fromIndex = request.fromIndex ?? 0;

    const credits: BankCredit[] = rows
      .slice(fromIndex)
      .filter((row) => row.isCredit)
      .map((row) => ({
        externalId: rowExternalId(file, row),
        valueDate: row.date,
        description: row.description,
        typeRaw: row.typeRaw,
        amountPence: row.amountPence.toString(),
        isCredit: true,
        ...(row.reference !== undefined ? { extractedReference: row.reference } : {}),
        // Exact, not guessed — a CSV export does not need the OCR confidence
        // signal (T-5.7). Left undefined per the port's own convention.
      }));

    // Small manual exports don't need pagination in practice; this always
    // finishes the file in one call, but the shape stays honest either way.
    return { credits };
  }

  private async csvFiles(): Promise<readonly string[]> {
    const entries = await readdir(this.config.uploadsDir);
    return entries.filter((f) => f.toLowerCase().endsWith('.csv')).sort();
  }

  private async findFile(statementNumber: number): Promise<string> {
    const files = await this.csvFiles();
    const match = files.find((f) => statementNumberFromFilename(f) === statementNumber);
    if (!match) {
      throw new PermanentProviderError(
        `No uploaded CSV found for statement ${statementNumber} in ${this.config.uploadsDir}.`,
        PROVIDER,
        'statement_not_found',
      );
    }
    return match;
  }

  private async readRows(file: string): Promise<readonly ParsedRow[]> {
    const text = await readFile(join(this.config.uploadsDir, file), 'utf8');
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) return [];

    const header = splitCsvLine(lines[0]!).map((h) => h.trim().toLowerCase());
    const col = (name: string): number => header.indexOf(name);
    const dateCol = firstPresent(col('date'), col('value date'), col('transaction date'));
    const descCol = firstPresent(col('description'), col('narrative'), col('reference'));
    const typeCol = col('type');
    const refCol = firstPresent(col('reference'), col('payment reference'));
    const amountCol = col('amount');
    const balanceCol = col('balance');

    if (dateCol === -1 || descCol === -1 || amountCol === -1) {
      throw new PermanentProviderError(
        `${file}: expected at least Date, Description and Amount columns; found "${lines[0]}".`,
        PROVIDER,
        'unrecognised_csv_shape',
      );
    }

    return lines.slice(1).map((line) => {
      const cells = splitCsvLine(line);
      const amountPence = parseAmountToPence(cells[amountCol] ?? '0');
      return {
        date: normaliseDate(cells[dateCol] ?? ''),
        description: (cells[descCol] ?? '').trim(),
        typeRaw: typeCol !== -1 ? (cells[typeCol] ?? '').trim() : 'Transfer',
        ...(refCol !== -1 && cells[refCol] ? { reference: cells[refCol].trim() } : {}),
        amountPence: amountPence < 0n ? -amountPence : amountPence,
        isCredit: amountPence > 0n,
        ...(balanceCol !== -1 && cells[balanceCol] ? { balancePence: parseAmountToPence(cells[balanceCol]) } : {}),
      };
    });
  }
}

function firstPresent(...indices: readonly number[]): number {
  return indices.find((i) => i !== -1) ?? -1;
}

function statementNumberFromFilename(file: string): number | undefined {
  const match = /(\d+)/.exec(file);
  return match ? Number(match[1]) : undefined;
}

function rowExternalId(file: string, row: ParsedRow): string {
  return createHash('sha256').update(`${file}:${row.date}:${row.description}:${row.amountPence}`).digest('hex').slice(0, 32);
}

/** Minimal RFC 4180 handling: quoted fields, escaped quotes, commas inside quotes. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

/** "1,234.56" or "-4.30" -> pence, without ever going through a float. */
function parseAmountToPence(raw: string): bigint {
  const cleaned = raw.replace(/[£,\s]/g, '');
  if (!cleaned) return 0n;
  const negative = cleaned.startsWith('-');
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [pounds = '0', fraction = ''] = unsigned.split('.');
  const fractionPence = (fraction + '00').slice(0, 2);
  const total = BigInt(pounds || '0') * 100n + BigInt(fractionPence || '0');
  return negative ? -total : total;
}

/** Accepts DD/MM/YYYY (the common UK export format) or an already-ISO date. */
function normaliseDate(raw: string): string {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
  const ukMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (ukMatch) {
    const [, d, m, y] = ukMatch;
    return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  }
  return trimmed;
}
