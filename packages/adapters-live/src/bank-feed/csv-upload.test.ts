import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CsvUploadBankFeed } from './csv-upload.js';

describe('CsvUploadBankFeed (GAP-33)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qosfc-bank-csv-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const CSV = [
    'Date,Description,Type,Amount,Balance',
    '01/03/2026,Opening balance carried forward,Transfer,0.00,100.00',
    '02/03/2026,J SMITH REF 1234,Standing Order,25.50,125.50',
    '03/03/2026,Card purchase,Card,-12.00,113.50',
    '04/03/2026,"Smith, J transfer",Transfer,"1,000.00",1113.50',
  ].join('\n');

  it('lists a statement with period and balances derived from the CSV', async () => {
    await writeFile(join(dir, '42.csv'), CSV, 'utf8');
    const feed = new CsvUploadBankFeed({ uploadsDir: dir });

    const statements = await feed.listStatements({});
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({
      statementNumber: 42,
      periodStart: '2026-03-01',
      periodEnd: '2026-03-04',
      source: 'csv',
      sourceRef: '42.csv',
    });
  });

  it('extracts only credits, in pence, skipping debits', async () => {
    await writeFile(join(dir, '42.csv'), CSV, 'utf8');
    const feed = new CsvUploadBankFeed({ uploadsDir: dir });

    const { credits } = await feed.extractCredits({ statementNumber: 42 });
    // Row 1 (£0.00) is neither credit nor debit; row 3 (card purchase) is a debit.
    expect(credits.map((c) => c.amountPence)).toEqual(['2550', '100000']);
    expect(credits.every((c) => c.isCredit)).toBe(true);
  });

  it('handles a quoted field containing a comma (RFC 4180)', async () => {
    await writeFile(join(dir, '42.csv'), CSV, 'utf8');
    const feed = new CsvUploadBankFeed({ uploadsDir: dir });
    const { credits } = await feed.extractCredits({ statementNumber: 42 });
    expect(credits[1]!.description).toBe('Smith, J transfer');
    expect(credits[1]!.amountPence).toBe('100000');
  });

  it('rejects a CSV without the required columns', async () => {
    await writeFile(join(dir, '7.csv'), 'Foo,Bar\n1,2\n', 'utf8');
    const feed = new CsvUploadBankFeed({ uploadsDir: dir });
    await expect(feed.extractCredits({ statementNumber: 7 })).rejects.toThrow(/expected at least/i);
  });

  it('reports no adapter available for a statement number that was never uploaded', async () => {
    const feed = new CsvUploadBankFeed({ uploadsDir: dir });
    await expect(feed.extractCredits({ statementNumber: 999 })).rejects.toThrow(/no uploaded csv/i);
  });
});
