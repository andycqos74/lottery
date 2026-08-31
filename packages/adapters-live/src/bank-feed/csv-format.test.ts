import { describe, expect, it } from 'vitest';
import { CsvFormatError, parseCanonicalStatementCsv } from './csv-format.js';

const VALID = `#statement 42 2026-08-01 2026-08-07 100000 105000
value_date,description,type,amount_pence,is_credit,reference,name
2026-08-03,"STANDING ORDER, REF 4521",Standing Order,500,true,4521,J Smith
2026-08-04,Cash withdrawal,Transfer,-2000,false,,
`;

describe('parseCanonicalStatementCsv', () => {
  it('parses the meta line and rows', () => {
    const { summary, rows } = parseCanonicalStatementCsv(VALID);
    expect(summary).toEqual({
      statementNumber: 42,
      periodStart: '2026-08-01',
      periodEnd: '2026-08-07',
      openingBalancePence: '100000',
      closingBalancePence: '105000',
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      valueDate: '2026-08-03',
      description: 'STANDING ORDER, REF 4521',
      amountPence: '500',
      isCredit: true,
      extractedReference: '4521',
      extractedName: 'J Smith',
    });
    expect(rows[1]!.isCredit).toBe(false);
    expect(rows[1]!.extractedReference).toBeUndefined();
  });

  it('rejects a missing meta line', () => {
    expect(() => parseCanonicalStatementCsv('value_date,description,type,amount_pence,is_credit,reference\n')).toThrow(
      CsvFormatError,
    );
  });

  it('rejects a header missing a required column', () => {
    const bad = `#statement 1 2026-08-01 2026-08-07 0 0\nvalue_date,description,amount_pence,is_credit,reference\n`;
    expect(() => parseCanonicalStatementCsv(bad)).toThrow(/missing column/);
  });

  it('rejects a non-numeric amount', () => {
    const bad = `#statement 1 2026-08-01 2026-08-07 0 0\nvalue_date,description,type,amount_pence,is_credit,reference\n2026-08-01,x,Transfer,abc,true,1\n`;
    expect(() => parseCanonicalStatementCsv(bad)).toThrow(/amount_pence must be a whole number/);
  });

  it('rejects an is_credit value that is not true or false', () => {
    const bad = `#statement 1 2026-08-01 2026-08-07 0 0\nvalue_date,description,type,amount_pence,is_credit,reference\n2026-08-01,x,Transfer,100,maybe,1\n`;
    expect(() => parseCanonicalStatementCsv(bad)).toThrow(/is_credit must be/);
  });
});
