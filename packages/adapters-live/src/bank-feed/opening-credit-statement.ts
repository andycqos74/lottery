/**
 * Reads one old-lottery statement file for the opening credit (switch-over
 * D2 (c), packages/domain/src/opening-credit.ts) — shared by
 * `tools/opening-credit.ts` and the admin console's /opening-credit page.
 *
 * Either format the Bank statements page accepts: the bank's own
 * "TransactionHistory" export (recognised by its header), or the canonical
 * `#statement` CSV. Amounts come back unsigned; `isCredit` says which way.
 */
import { pence, type OpeningCreditStatementLine } from '@qosfc/domain';
import { parseCanonicalStatementCsv } from './csv-format.js';
import { looksLikeRealExportCsv, parseRealExportCsv } from './real-export-csv-format.js';

export function readOpeningCreditStatement(text: string): OpeningCreditStatementLine[] {
  const body = text.replace(/^\uFEFF/, '');
  const firstLine = body.slice(0, body.search(/\r?\n|$/));
  const rows = looksLikeRealExportCsv(firstLine) ? parseRealExportCsv(body).rows : parseCanonicalStatementCsv(body).rows;
  return rows.map((r) => ({
    externalId: r.externalId,
    valueDate: r.valueDate,
    amountPence: pence(BigInt(r.amountPence.replace(/^-/, ''))),
    isCredit: r.isCredit,
    typeRaw: r.typeRaw,
    reference: r.extractedReference ?? null,
    description: r.description,
    name: r.extractedName ?? null,
  }));
}
