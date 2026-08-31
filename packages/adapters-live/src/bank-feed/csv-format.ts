/**
 * The canonical CSV schema for a bank statement upload (GAP-33: CSV chosen
 * over Open Banking and OCR — confirmed by Andy Cowan; Open Banking stays a
 * future-consideration item, not attempted here).
 *
 * This is a schema we defined ourselves, not a mapping of any particular
 * bank's actual export columns — nobody has fed this a real statement yet
 * (gap-register.md B-10). Producing one is a small, separate step: map the
 * real export's columns onto the fields below, or transform it upstream of
 * this parser. Keeping that mapping out of the parser is what makes it a
 * small step rather than a rewrite when a sample file finally exists.
 *
 * File shape:
 *   line 1   "#statement <number> <periodStart> <periodEnd> <openingPence> <closingPence>"
 *   line 2   header: value_date,description,type,amount_pence,is_credit,reference[,name]
 *   line 3+  one row per transaction
 *
 * Dates are ISO (YYYY-MM-DD). Amounts are integer pence — never a decimal
 * pound value, which is exactly the float-money mistake T-1.1 exists to rule
 * out everywhere else in this codebase.
 */
import type { BankCredit, StatementSummary } from '@qosfc/ports';

export interface ParsedStatement {
  readonly summary: Omit<StatementSummary, 'source' | 'sourceRef'>;
  readonly rows: readonly BankCredit[];
}

const HEADER_COLUMNS = ['value_date', 'description', 'type', 'amount_pence', 'is_credit', 'reference'] as const;

export class CsvFormatError extends Error {}

/** Splits one CSV line, honouring double-quoted fields containing commas. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

export function parseCanonicalStatementCsv(text: string): ParsedStatement {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new CsvFormatError('Statement CSV must have a "#statement" meta line and a header row, at minimum.');
  }

  const metaLine = lines[0]!;
  const metaMatch = /^#statement\s+(\d+)\s+(\S+)\s+(\S+)\s+(-?\d+)\s+(-?\d+)\s*$/.exec(metaLine);
  if (!metaMatch) {
    throw new CsvFormatError(
      `First line must be "#statement <number> <periodStart> <periodEnd> <openingPence> <closingPence>", got: "${metaLine}"`,
    );
  }
  const [, statementNumberRaw, periodStart, periodEnd, openingPence, closingPence] = metaMatch as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const header = splitCsvLine(lines[1]!).map((h) => h.toLowerCase());
  const missing = HEADER_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new CsvFormatError(`Header row is missing column(s): ${missing.join(', ')}. Got: ${lines[1]}`);
  }
  const nameIdx = header.indexOf('name');

  const rows: BankCredit[] = lines.slice(2).map((line, rowIndex) => {
    const fields = splitCsvLine(line);
    const get = (col: string): string => {
      const idx = header.indexOf(col);
      return fields[idx] ?? '';
    };
    const amountPence = get('amount_pence');
    if (!/^-?\d+$/.test(amountPence)) {
      throw new CsvFormatError(`Row ${rowIndex + 3}: amount_pence must be a whole number of pence, got "${amountPence}".`);
    }
    const isCreditRaw = get('is_credit').toLowerCase();
    if (isCreditRaw !== 'true' && isCreditRaw !== 'false') {
      throw new CsvFormatError(`Row ${rowIndex + 3}: is_credit must be "true" or "false", got "${isCreditRaw}".`);
    }

    const reference = get('reference');
    const name = nameIdx >= 0 ? fields[nameIdx] : undefined;

    return {
      externalId: `csv:${statementNumberRaw}:${rowIndex}`,
      valueDate: get('value_date'),
      description: get('description'),
      typeRaw: get('type'),
      amountPence,
      isCredit: isCreditRaw === 'true',
      // A human typed or exported this row; there is no OCR uncertainty to record,
      // so `confidence` is left unset rather than assigned `undefined`.
      ...(reference ? { extractedReference: reference } : {}),
      ...(name ? { extractedName: name } : {}),
    };
  });

  return {
    summary: {
      statementNumber: Number(statementNumberRaw),
      periodStart,
      periodEnd,
      openingBalancePence: openingPence,
      closingBalancePence: closingPence,
    },
    rows,
  };
}
