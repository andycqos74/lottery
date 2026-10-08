import { describe, expect, it } from 'vitest';
import {
  alsoNumbers,
  GAP_35_QUARANTINE,
  isUkPostcode,
  LEGACY_REGISTER_COLUMNS,
  parseDelimited,
  parseFrequency,
  parsePounds,
  parseUkDate,
  planLegacyRegister,
  readLegacyRegister,
  type LegacyRow,
} from './legacy-register.js';

const HEADER = Object.values(LEGACY_REGISTER_COLUMNS);

// Synthetic — B-2 keeps real member data out of the repository. Same shape as the register.
const BASE: Omit<LegacyRow, 'sourceRow'> = {
  prizeDrawNo: '1002', title: 'Mr', forename: 'Ken', surname: 'Example', address1: '1 Test Road', address2: 'Corstorphine',
  address3: 'Edinburgh', postCode: 'EH12 6NS', telephone: '0131 000 0000', agent: 'SO', channel: 'Direct (bank)',
  joiningDate: '', paymentRaw: '£8.68 monthly', amount: '8.68', frequency: 'monthly', info: '', rowType: 'MEMBER',
  status: 'PAYING', payments12m: '12', total12m: '104.16', observedFrequency: 'monthly',
};
let nextRow = 2;
const row = (over: Partial<LegacyRow>): LegacyRow => ({ ...BASE, sourceRow: nextRow++, ...over });
const blankReserved = (no: string): LegacyRow =>
  row({ prizeDrawNo: no, title: '', forename: '', surname: '', address1: '', address2: '', address3: '', postCode: '', telephone: '',
    agent: '', channel: '', paymentRaw: '', amount: '', frequency: '', rowType: 'BLANK RESERVED', status: '', payments12m: '', total12m: '', observedFrequency: '' });

describe('reading the register file', () => {
  it('reads a pasted (tab-separated) register by its header, in any column order', () => {
    const text = [[...HEADER].reverse().join('\t'), Object.values({ ...BASE }).reverse().join('\t'), '\t\t', ''].join('\n');
    const rows = readLegacyRegister(parseDelimited(text));
    expect(rows).toHaveLength(1); // the empty line is skipped
    expect(rows[0]).toMatchObject({ sourceRow: 2, prizeDrawNo: '1002', surname: 'Example', total12m: '104.16' });
  });

  it('reads a CSV with quoted commas, quotes and a byte-order mark', () => {
    const cells = parseDelimited('﻿a,b,c\r\n"1, High St","say ""hi""",x\r\n');
    expect(cells).toEqual([['a', 'b', 'c'], ['1, High St', 'say "hi"', 'x']]);
  });

  it('refuses a file missing a column, naming it', () => {
    const header = HEADER.filter((h) => h !== 'Observed Freq');
    expect(() => readLegacyRegister([header])).toThrow(/"Observed Freq"/);
  });
});

describe('reading a cell', () => {
  it('parses money to pence without floating point (GAP-41: £8.68 stays £8.68)', () => {
    expect(parsePounds('8.68')).toBe(868n);
    expect(parsePounds('£104.16')).toBe(10416n);
    expect(parsePounds('5')).toBe(500n);
    expect(parsePounds('4.5')).toBe(450n);
    expect(parsePounds('1,040.00')).toBe(104000n);
    expect(parsePounds('£8.68 monthly')).toBeNull();
    expect(parsePounds('8.685')).toBeNull();
  });

  it('parses frequencies, and nothing else', () => {
    expect(parseFrequency('Monthly')).toBe('monthly');
    expect(parseFrequency('6 monthly')).toBe('6monthly');
    expect(parseFrequency('yearly')).toBe('annual');
    expect(parseFrequency('irregular')).toBeNull();
  });

  it('reads British dates and Excel serial days', () => {
    expect(parseUkDate('03/04/2019')).toBe('2019-04-03');
    expect(parseUkDate('3/4/19')).toBe('2019-04-03');
    expect(parseUkDate('2019-04-03')).toBe('2019-04-03');
    expect(parseUkDate('43558')).toBe('2019-04-03');
    expect(parseUkDate('25569')).toBe('1970-01-01');
    expect(parseUkDate('29/02/2023')).toBeNull();
    expect(parseUkDate('29/02/2024')).toBe('2024-02-29');
    expect(parseUkDate('sometime')).toBeNull();
  });

  it('checks a postcode is UK-shaped', () => {
    expect(isUkPostcode('EH12 6NS')).toBe(true);
    expect(isUkPostcode('eh126ns')).toBe(true);
    expect(isUkPostcode('EH12')).toBe(false);
  });

  it('finds the numbers an "Also" note names', () => {
    expect(alsoNumbers('Also 1030')).toEqual([1030]);
    expect(alsoNumbers('wife; also 1030 & 1031')).toEqual([1030, 1031]);
    expect(alsoNumbers('Moved 1030')).toEqual([]);
  });
});

describe('planning the load', () => {
  it('loads the example row as one paying person with a standing order (FR-4.2: £8.68 monthly = £104.16 a year)', () => {
    const plan = planLegacyRegister([row({})]);
    expect(plan.reconciliationFailures).toEqual([]);
    expect(plan.members).toEqual([
      expect.objectContaining({ forename: 'Ken', surname: 'Example', postCode: 'EH12 6NS', postCodeValid: true, status: 'active', prizeDrawNos: [1002], flags: [] }),
    ]);
    expect(plan.numbers[0]).toMatchObject({
      prizeDrawNo: 1002, rowType: 'member', memberIndex: 0, legacyAgent: 'SO', legacyChannel: 'direct_bank',
      legacyPaymentRaw: '£8.68 monthly', legacyAmountPence: 868n, legacyFrequency: 'monthly', legacyStatusText: 'PAYING',
      payments12m: 12, total12mPence: 10416n, observedFrequency: 'monthly',
      standingOrder: { amountPence: 868n, frequency: 'monthly', annualBasisPence: 10416n },
    });
  });

  it('makes one person of numbers linked by "Also", contact details from the lowest number (GAP-06)', () => {
    const plan = planLegacyRegister([
      row({ prizeDrawNo: '1030', info: 'Also 1002', address1: '2 Other Road', joiningDate: '01/06/2015' }),
      row({ prizeDrawNo: '1002', info: 'Also 1030', joiningDate: '01/01/2010' }),
    ]);
    expect(plan.members).toHaveLength(1);
    expect(plan.members[0]).toMatchObject({ prizeDrawNos: [1002, 1030], address1: '1 Test Road', joiningDate: '2010-01-01' });
    expect(plan.members[0]!.flags).toContain('contact_details_differ');
    expect(plan.numbers.map((n) => n.memberIndex)).toEqual([0, 0]);
    expect(plan.counts).toMatchObject({ people: 1, memberRows: 2, standingOrders: 2 });
  });

  it('does not merge an "Also" link to someone with a different name — flags it instead', () => {
    const plan = planLegacyRegister([
      row({ prizeDrawNo: '1002', info: 'Also 1030' }),
      row({ prizeDrawNo: '1030', forename: 'Jean', surname: 'Other', postCode: 'G1 1AA' }),
      row({ prizeDrawNo: '1040', info: 'Also 9999' }),
    ]);
    expect(plan.members).toHaveLength(3);
    expect(plan.findings.map((f) => [f.prizeDrawNo, f.flag])).toEqual(
      expect.arrayContaining([[1002, 'also_number_not_merged'], [1040, 'also_number_not_in_register']]),
    );
  });

  it('flags the same name at the same postcode without merging', () => {
    const plan = planLegacyRegister([row({ prizeDrawNo: '1002' }), row({ prizeDrawNo: '1003' })]);
    expect(plan.members).toHaveLength(2);
    expect(plan.members.every((m) => m.flags.includes('possible_same_person'))).toBe(true);
  });

  it('GAP-07: rejects every copy of a duplicated number', () => {
    const plan = planLegacyRegister([row({ prizeDrawNo: '1253' }), row({ prizeDrawNo: '1253', forename: 'Two' }), row({ prizeDrawNo: '1254' })]);
    expect(plan.rejected.map((r) => [r.prizeDrawNo, r.reason])).toEqual([
      [1253, 'GAP-07: Prize Draw No 1253 appears 2 times'],
      [1253, 'GAP-07: Prize Draw No 1253 appears 2 times'],
    ]);
    expect(plan.numbers.map((n) => n.prizeDrawNo)).toEqual([1254]);
    expect(plan.reconciliationFailures).toEqual([]);
  });

  it('rejects rows with no usable number or row type', () => {
    const plan = planLegacyRegister([row({ prizeDrawNo: '' }), row({ prizeDrawNo: '12a' }), row({ prizeDrawNo: '1005', rowType: 'NOTE' })]);
    expect(plan.rejected).toHaveLength(3);
    expect(plan.counts).toMatchObject({ rowsRead: 3, rejectedRows: 3, memberRows: 0 });
  });

  it('loads BLANK RESERVED numbers with no person (FR-15.2)', () => {
    const plan = planLegacyRegister([blankReserved('3001'), row({})]);
    expect(plan.numbers.find((n) => n.prizeDrawNo === 3001)).toMatchObject({ rowType: 'blank_reserved', memberIndex: null, standingOrder: null });
    expect(plan.counts).toMatchObject({ blankReservedRows: 1, memberRows: 1, people: 1 });
  });

  it('GAP-20: no amount is loaded, flagged, and has no standing order', () => {
    const plan = planLegacyRegister([row({ amount: '', paymentRaw: 'SO' })]);
    expect(plan.numbers[0]).toMatchObject({ legacyAmountPence: null, legacyPaymentRaw: 'SO', standingOrder: null });
    expect(plan.members[0]!.flags).toContain('amount_unknown');
  });

  it('a person with no paying number is lapsed and has no standing order', () => {
    const plan = planLegacyRegister([row({ status: 'NOT PAYING', payments12m: '0', total12m: '0' })]);
    expect(plan.members[0]!.status).toBe('lapsed');
    expect(plan.numbers[0]!.standingOrder).toBeNull();
    expect(plan.numbers[0]!.legacyStatusText).toBe('NOT PAYING');
  });

  it('GAP-19 (c): an agent-collected number gets no standing order', () => {
    const plan = planLegacyRegister([row({ channel: 'Agent', agent: 'Bob Agent' })]);
    expect(plan.numbers[0]).toMatchObject({ legacyChannel: 'agent_collected', legacyAgent: 'Bob Agent', standingOrder: null });
    expect(plan.counts.agentCollectedNumbers).toBe(1);
  });

  it('GAP-35: quarantines by number and by name, with no standing order', () => {
    const plan = planLegacyRegister(
      [row({ prizeDrawNo: '1304', forename: 'Pat' }), row({ prizeDrawNo: '1400', forename: 'Alan', surname: 'Henry', postCode: 'G1 1AA' }), row({ prizeDrawNo: '1500', forename: 'Free', postCode: 'G2 2BB' })],
      { quarantineNumbers: GAP_35_QUARANTINE.numbers, quarantineNames: GAP_35_QUARANTINE.names },
    );
    expect(plan.members.map((m) => m.status)).toEqual(['quarantined', 'quarantined', 'active']);
    expect(plan.numbers.map((n) => n.standingOrder === null)).toEqual([true, true, false]);
  });

  it('flags when the bank shows a different frequency from the register', () => {
    const plan = planLegacyRegister([row({ observedFrequency: 'quarterly' })]);
    expect(plan.findings.map((f) => f.flag)).toContain('observed_frequency_differs');
  });

  it('GAP-40: fails the plan when the counts are not what the register is known to hold', () => {
    const plan = planLegacyRegister([row({}), blankReserved('3001')], { expect: { rows: 2, memberRows: 2, blankReservedRows: 1 } });
    expect(plan.reconciliationFailures).toEqual(['expected 2 member rows, found 1']);
  });

  it('tallies the values seen in the columns that drive decisions', () => {
    const plan = planLegacyRegister([row({}), row({ prizeDrawNo: '1003', status: 'LAPSED', forename: 'B' })]);
    expect(plan.valuesSeen.status).toEqual({ PAYING: 1, LAPSED: 1 });
    expect(plan.valuesSeen.channel).toEqual({ 'Direct (bank)': 2 });
  });
});
