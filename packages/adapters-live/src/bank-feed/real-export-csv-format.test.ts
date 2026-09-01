import { describe, expect, it } from 'vitest';
import { looksLikeRealExportCsv, parseRealExportCsv, RealExportCsvFormatError } from './real-export-csv-format.js';

const HEADER =
  'TransactionDate,ValueDate,Account,AccountName,Debit-Credit,TransactionCode,TransactionType,Amount,Description,Reference,Source,Currency';

// A cut-down, representative slice of the real export (B-10) — a cheque (DR,
// no description), a Transfer whose Description itself contains commas, and a
// Standing Order, which is exactly the mix that makes right-anchored column
// splitting necessary.
const SAMPLE = `${HEADER}
20260818,,82621330460449CA,AAA,DR,,Cheque,-25,,19125,,GBP
20260818,,82621330460449CA,AAA,CR,,Transfer,4.34,FPS, Justice Js& Mrs E, 1990,1990,"00000000000000",GBP
20260818,,82621330460449CA,AAA,CR,,Standing Order,8.64,Mr Bryan Kirkpatri, 1643 DD1113 B KIRK,1643 DD1113 B KIRK,"00000000000000",GBP
`;

describe('looksLikeRealExportCsv', () => {
  it('recognises the real export header', () => {
    expect(looksLikeRealExportCsv(HEADER)).toBe(true);
  });

  it('does not mistake the canonical schema for it', () => {
    expect(looksLikeRealExportCsv('value_date,description,type,amount_pence,is_credit,reference')).toBe(false);
  });
});

describe('parseRealExportCsv', () => {
  it('parses a cheque (debit), a transfer, and a standing order', () => {
    const { periodStart, periodEnd, rows } = parseRealExportCsv(SAMPLE);
    expect(periodStart).toBe('2026-08-18');
    expect(periodEnd).toBe('2026-08-18');
    expect(rows).toHaveLength(3);

    expect(rows[0]).toMatchObject({ valueDate: '2026-08-18', isCredit: false, amountPence: '-2500', typeRaw: 'Cheque' });
    expect(rows[0]!.extractedReference).toBe('19125');

    expect(rows[1]).toMatchObject({
      isCredit: true,
      amountPence: '434',
      description: 'FPS, Justice Js& Mrs E, 1990',
      extractedReference: '1990',
      typeRaw: 'Transfer',
    });

    expect(rows[2]).toMatchObject({ isCredit: true, amountPence: '864', typeRaw: 'Standing Order', extractedReference: '1643 DD1113 B KIRK' });
  });

  it('gives the same row the same externalId whichever of two overlapping exports it appears in', () => {
    const exportA = `${HEADER}\n20260818,,82621330460449CA,AAA,CR,,Transfer,4.34,"FPS, Justice Js& Mrs E, 1990",1990,"00000000000000",GBP\n`;
    const exportB = `${HEADER}\n20260817,,82621330460449CA,AAA,DR,,Cheque,-500,,19108,,GBP\n20260818,,82621330460449CA,AAA,CR,,Transfer,4.34,"FPS, Justice Js& Mrs E, 1990",1990,"00000000000000",GBP\n`;
    const a = parseRealExportCsv(exportA);
    const b = parseRealExportCsv(exportB);
    expect(a.rows[0]!.externalId).toBe(b.rows[1]!.externalId);
  });

  it('rejects a header missing a required column', () => {
    expect(() => parseRealExportCsv('TransactionDate,ValueDate,Account\n20260818,,x\n')).toThrow(/missing column/);
  });

  it('rejects a row whose Debit-Credit disagrees with the sign of Amount', () => {
    const bad = `${HEADER}\n20260818,,82621330460449CA,AAA,CR,,Transfer,-4.34,x,1,,GBP\n`;
    expect(() => parseRealExportCsv(bad)).toThrow(RealExportCsvFormatError);
  });

  it('rejects a non-decimal amount', () => {
    const bad = `${HEADER}\n20260818,,82621330460449CA,AAA,CR,,Transfer,not-a-number,x,1,,GBP\n`;
    expect(() => parseRealExportCsv(bad)).toThrow(/decimal pounds/);
  });
});
