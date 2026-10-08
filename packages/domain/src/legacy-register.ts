/**
 * The legacy register import — T-11, FR-1.3, FR-15.2.
 *
 * Reads QOSFC's working copy of the register (one row per prize draw number)
 * and plans what to load: people (`member`, GAP-06 person-as-member), their
 * immutable prize draw numbers (`member_number`, including the BLANK RESERVED
 * numbers that belong to nobody), and the standing orders that are still paying.
 * Pure: the plan is written by `importLegacyRegister` in packages/activities,
 * and a dry run prints it without touching the database.
 *
 * Nothing in a row is corrected. Where a row is doubtful it is loaded as it
 * stands with a flag (`verify_flags`) for a person to look at; where it cannot
 * be loaded at all it goes to the exception report instead:
 *
 *   GAP-07  a prize draw number appearing twice — every copy is rejected
 *   GAP-20  no amount — loaded, flagged `amount_unknown`, no standing order
 *   GAP-35  open member queries — loaded as `quarantined`
 *   GAP-40  the counts must reconcile, or the plan is not committable
 *   GAP-41  the raw payment string is kept verbatim, never normalised
 */
import { type Pence, pence } from './money.js';

export type LegacyFrequency = 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | '6monthly' | 'annual';
export type LegacyChannel = 'direct_bank' | 'agent_collected' | 'unknown';
export type LegacyMemberStatus = 'active' | 'lapsed' | 'quarantined';

/** The register's columns, by the header text in its first row. */
export const LEGACY_REGISTER_COLUMNS = {
  prizeDrawNo: 'Prize Draw No',
  title: 'Title',
  forename: 'Forename',
  surname: 'Surname',
  address1: 'Address 1',
  address2: 'Address 2',
  address3: 'Address 3',
  postCode: 'Post Code',
  telephone: 'Telephone',
  agent: 'Agent',
  channel: 'Channel',
  joiningDate: 'Joining Date',
  paymentRaw: 'Payment Type (raw)',
  amount: 'Amount (parsed)',
  frequency: 'Frequency (parsed)',
  info: 'Info',
  rowType: 'Row Type',
  status: 'Status',
  payments12m: 'Payments (12m)',
  total12m: 'Total (12m)',
  observedFrequency: 'Observed Freq',
} as const;

type ColumnKey = keyof typeof LEGACY_REGISTER_COLUMNS;
export type LegacyRow = { readonly sourceRow: number } & { readonly [K in ColumnKey]: string };

/** Flags a person should check. Stable codes: they are stored in `verify_flags`. */
export type LegacyFlag =
  | 'amount_unknown' // GAP-20
  | 'amount_unreadable'
  | 'frequency_unknown'
  | 'channel_unknown'
  | 'postcode_invalid'
  | 'joining_date_unreadable'
  | 'observed_frequency_differs'
  | 'observed_total_unreadable'
  | 'also_number_not_in_register'
  | 'also_number_not_merged'
  | 'possible_same_person'
  | 'contact_details_differ'
  | 'quarantined'; // GAP-35

export interface Finding {
  readonly sourceRow: number;
  readonly prizeDrawNo: number | null;
  readonly flag: LegacyFlag;
  readonly detail: string;
}

export interface RejectedRow {
  readonly sourceRow: number;
  readonly prizeDrawNo: number | null;
  readonly reason: string;
}

export interface PlannedStandingOrder {
  readonly amountPence: Pence;
  readonly frequency: LegacyFrequency;
  readonly annualBasisPence: Pence;
}

export interface PlannedNumber {
  readonly prizeDrawNo: number;
  readonly sourceRow: number;
  readonly rowType: 'member' | 'blank_reserved';
  /** Index into `LegacyRegisterPlan.members`; null for a blank reserved number. */
  readonly memberIndex: number | null;
  readonly legacyAgent: string | null;
  readonly legacyChannel: LegacyChannel;
  readonly legacyPaymentRaw: string | null;
  readonly legacyAmountPence: Pence | null;
  readonly legacyFrequency: LegacyFrequency | null;
  readonly legacyStatusText: string | null;
  readonly legacyInfo: string | null;
  readonly payments12m: number | null;
  readonly total12mPence: Pence | null;
  readonly observedFrequency: string | null;
  /** Set only for a paying, bank-paid number with a known amount and frequency. */
  readonly standingOrder: PlannedStandingOrder | null;
}

export interface PlannedMember {
  /** The row the contact details were taken from: the person's lowest prize draw number. */
  readonly sourceRow: number;
  readonly title: string | null;
  readonly forename: string | null;
  readonly surname: string | null;
  readonly address1: string | null;
  readonly address2: string | null;
  readonly address3: string | null;
  readonly postCode: string | null;
  readonly postCodeValid: boolean;
  readonly telephone: string | null;
  readonly joiningDate: string | null;
  readonly status: LegacyMemberStatus;
  readonly prizeDrawNos: readonly number[];
  readonly flags: readonly LegacyFlag[];
}

export interface LegacyRegisterCounts {
  readonly rowsRead: number;
  readonly memberRows: number;
  readonly blankReservedRows: number;
  readonly rejectedRows: number;
  readonly people: number;
  readonly peopleActive: number;
  readonly peopleLapsed: number;
  readonly peopleQuarantined: number;
  readonly standingOrders: number;
  readonly agentCollectedNumbers: number;
}

export interface LegacyRegisterPlan {
  readonly members: readonly PlannedMember[];
  readonly numbers: readonly PlannedNumber[];
  readonly rejected: readonly RejectedRow[];
  readonly findings: readonly Finding[];
  readonly counts: LegacyRegisterCounts;
  /** GAP-40: why the counts do not reconcile. Empty means the plan may be committed. */
  readonly reconciliationFailures: readonly string[];
  /** Each distinct value seen in the free-text columns that drive a decision, with how often. */
  readonly valuesSeen: Readonly<Record<'rowType' | 'status' | 'channel' | 'agent' | 'frequency' | 'observedFrequency', Readonly<Record<string, number>>>>;
}

export interface LegacyRegisterOptions {
  /** GAP-35: prize draw numbers whose holder is quarantined on load. */
  readonly quarantineNumbers?: readonly number[];
  /** GAP-35: "Forename Surname" whose every number is quarantined on load. */
  readonly quarantineNames?: readonly string[];
  /** GAP-40: counts the register is known to hold. Any that differ fail the plan. */
  readonly expect?: { readonly rows?: number; readonly memberRows?: number; readonly blankReservedRows?: number };
}

/** GAP-35, as recorded in docs/gap-register.md: Pattie #1304, and Alan Henry's rows. */
export const GAP_35_QUARANTINE = { numbers: [1304], names: ['Alan Henry'] } as const;

// ---------------------------------------------------------------------------
// Reading the file

/**
 * Splits a CSV or tab-separated export into rows of cells. The delimiter is
 * whichever of tab or comma the header line has more of (a pasted
 * spreadsheet is tab-separated; "Save as CSV" is commas). Quoted cells may
 * hold the delimiter, newlines and doubled quotes.
 */
export function parseDelimited(text: string): string[][] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const headerLine = body.slice(0, body.search(/\r?\n|$/));
  const delimiter = (headerLine.match(/\t/g)?.length ?? 0) >= (headerLine.match(/,/g)?.length ?? 0) ? '\t' : ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const headerKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Maps cells to named columns by the header row. Every column must be
 * present (in any order); extra columns are ignored. Wholly empty lines are
 * skipped. `sourceRow` is the spreadsheet row number, header = row 1.
 */
export function readLegacyRegister(cells: readonly (readonly string[])[]): LegacyRow[] {
  const [header, ...data] = cells;
  if (!header) throw new Error('The register file is empty.');
  const position = new Map(header.map((h, i) => [headerKey(h), i]));
  const missing = Object.values(LEGACY_REGISTER_COLUMNS).filter((h) => !position.has(headerKey(h)));
  if (missing.length > 0) {
    throw new Error(`The register is missing column(s): ${missing.map((m) => `"${m}"`).join(', ')}. Found: ${header.join(' | ')}`);
  }

  const rows: LegacyRow[] = [];
  data.forEach((cellsInRow, i) => {
    if (cellsInRow.every((c) => c.trim() === '')) return;
    const row: Record<string, string | number> = { sourceRow: i + 2 };
    for (const [key, heading] of Object.entries(LEGACY_REGISTER_COLUMNS)) {
      row[key] = (cellsInRow[position.get(headerKey(heading))!] ?? '').trim();
    }
    rows.push(row as unknown as LegacyRow);
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Reading a cell

const blank = (s: string): string | null => (s.trim() === '' ? null : s.trim());

/** "£8.68", "8.68", "8" → pence. Never via a float. Null when it isn't money. */
export function parsePounds(text: string): Pence | null {
  const m = /^£?\s*(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text.replace(/,/g, '').trim());
  if (!m) return null;
  return pence(BigInt(m[1]!) * 100n + BigInt((m[2] ?? '0').padEnd(2, '0')));
}

const FREQUENCIES: Record<string, LegacyFrequency> = {
  weekly: 'weekly',
  fortnightly: 'fortnightly',
  monthly: 'monthly',
  quarterly: 'quarterly',
  '6monthly': '6monthly',
  '6 monthly': '6monthly',
  '6-monthly': '6monthly',
  'half yearly': '6monthly',
  'half-yearly': '6monthly',
  annual: 'annual',
  annually: 'annual',
  yearly: 'annual',
};

export function parseFrequency(text: string): LegacyFrequency | null {
  return FREQUENCIES[text.trim().toLowerCase()] ?? null;
}

const PER_YEAR: Record<LegacyFrequency, bigint> = {
  weekly: 52n,
  fortnightly: 26n,
  monthly: 12n,
  quarterly: 4n,
  '6monthly': 2n,
  annual: 1n,
};

/** "Direct (bank)" → direct_bank; anything naming an agent → agent_collected. */
export function parseChannel(text: string): LegacyChannel {
  const t = text.trim().toLowerCase();
  if (t.startsWith('direct') || t.includes('bank')) return 'direct_bank';
  if (t.includes('agent')) return 'agent_collected';
  return 'unknown';
}

/**
 * dd/mm/yyyy, dd/mm/yy, dd-mm-yyyy, yyyy-mm-dd, or an Excel serial day
 * number (an .xlsx saved as CSV without formatting) → yyyy-mm-dd. The
 * register is British, so 03/04/2019 is 3 April.
 */
export function parseUkDate(text: string): string | null {
  const t = text.trim();
  let y: number, mo: number, d: number;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(t))) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t))) {
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 100) y += y > 50 ? 1900 : 2000;
  } else if (/^\d{5}$/.test(t)) {
    // Excel's day 1 is 1900-01-01, and it counts a 29 Feb 1900 that never
    // was — so serial 25569 is 1970-01-01.
    [y, mo, d] = civilFromDays(Number(t) - 25_569);
  } else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInMonth = (y: number, m: number) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;

/** Days since 1970-01-01 → [year, month, day]. Arithmetic, not `Date`: this module is imported by workflow code. */
function civilFromDays(days: number): [number, number, number] {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

/** A UK postcode in its usual shape (FR-12.2) — the shape, not that Royal Mail delivers to it. */
export function isUkPostcode(text: string): boolean {
  return /^(GIR ?0AA|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})$/i.test(text.trim());
}

/** The numbers an Info note such as "Also 1030" or "also 1030 & 1031" says the same person holds. */
export function alsoNumbers(info: string): number[] {
  const at = info.search(/\balso\b/i);
  if (at < 0) return [];
  return (info.slice(at).match(/\b\d{1,5}\b/g) ?? []).map(Number);
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const normPostcode = (s: string) => s.replace(/\s+/g, '').toUpperCase();

function tally(rows: readonly LegacyRow[], key: ColumnKey): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r[key]] = (out[r[key]] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------
// The plan

export function planLegacyRegister(rows: readonly LegacyRow[], options: LegacyRegisterOptions = {}): LegacyRegisterPlan {
  const findings: Finding[] = [];
  const rejected: RejectedRow[] = [];
  const flag = (row: LegacyRow, prizeDrawNo: number | null, f: LegacyFlag, detail: string) =>
    findings.push({ sourceRow: row.sourceRow, prizeDrawNo, flag: f, detail });

  // Row level: a number we can key on, and a row type we understand.
  const keyed: { row: LegacyRow; no: number; rowType: 'member' | 'blank_reserved' }[] = [];
  for (const row of rows) {
    const no = /^\d{1,7}$/.test(row.prizeDrawNo) ? Number(row.prizeDrawNo) : null;
    if (no === null) {
      rejected.push({ sourceRow: row.sourceRow, prizeDrawNo: null, reason: `Prize Draw No "${row.prizeDrawNo}" is not a whole number` });
      continue;
    }
    const type = norm(row.rowType);
    const rowType = type === 'member' ? 'member' : type.includes('blank') ? 'blank_reserved' : null;
    if (!rowType) {
      rejected.push({ sourceRow: row.sourceRow, prizeDrawNo: no, reason: `Row Type "${row.rowType}" is neither MEMBER nor BLANK RESERVED` });
      continue;
    }
    keyed.push({ row, no, rowType });
  }

  // GAP-07: a number appearing more than once cannot be keyed — reject every copy.
  const occurrences = new Map<number, number>();
  for (const k of keyed) occurrences.set(k.no, (occurrences.get(k.no) ?? 0) + 1);
  const unique = keyed.filter((k) => {
    if (occurrences.get(k.no)! === 1) return true;
    rejected.push({ sourceRow: k.row.sourceRow, prizeDrawNo: k.no, reason: `GAP-07: Prize Draw No ${k.no} appears ${occurrences.get(k.no)} times` });
    return false;
  });

  // GAP-06: group member rows into people. Only an Info "Also NNNN" note links
  // two numbers, and only when the surname agrees and either the forename or
  // the postcode does too — two people sharing one login would be worse than
  // one person with two, which staff can merge later.
  const memberRows = unique.filter((k) => k.rowType === 'member');
  const byNo = new Map(memberRows.map((k) => [k.no, k]));
  const parent = new Map(memberRows.map((k) => [k.no, k.no]));
  const find = (n: number): number => {
    let p = parent.get(n)!;
    while (p !== parent.get(p)) p = parent.get(p)!;
    parent.set(n, p);
    return p;
  };
  const allNumbers = new Set(keyed.map((k) => k.no));
  for (const k of memberRows) {
    for (const other of alsoNumbers(k.row.info)) {
      if (other === k.no) continue;
      const o = byNo.get(other);
      if (!o) {
        flag(k.row, k.no, 'also_number_not_in_register',
          allNumbers.has(other)
            ? `Info says "also ${other}", but ${other} is not a loadable member row`
            : `Info says "also ${other}", which is not in the register`);
        continue;
      }
      const sameSurname = norm(k.row.surname) === norm(o.row.surname) && k.row.surname.trim() !== '';
      const sameForename = norm(k.row.forename) === norm(o.row.forename);
      const samePostcode = k.row.postCode !== '' && normPostcode(k.row.postCode) === normPostcode(o.row.postCode);
      if (sameSurname && (sameForename || samePostcode)) parent.set(find(k.no), find(other));
      else {
        flag(k.row, k.no, 'also_number_not_merged',
          `Info says "also ${other}", but ${other} is ${o.row.forename} ${o.row.surname}, ${o.row.postCode} — kept as separate people`);
      }
    }
  }
  const groups = new Map<number, typeof memberRows>();
  for (const k of memberRows) {
    const root = find(k.no);
    groups.set(root, [...(groups.get(root) ?? []), k]);
  }

  const quarantineNumbers = new Set(options.quarantineNumbers ?? []);
  const quarantineNames = new Set((options.quarantineNames ?? []).map(norm));

  const members: PlannedMember[] = [];
  const memberIndexOf = new Map<number, number>();
  const sortedGroups = [...groups.values()].map((g) => [...g].sort((a, b) => a.no - b.no)).sort((a, b) => a[0]!.no - b[0]!.no);
  for (const group of sortedGroups) {
    const first = group[0]!.row;
    const flags = new Set<LegacyFlag>();

    const address = (r: LegacyRow) => [r.address1, r.address2, r.address3, normPostcode(r.postCode)].map(norm).join('|');
    if (group.some((k) => address(k.row) !== address(first) || norm(k.row.telephone) !== norm(first.telephone))) {
      flags.add('contact_details_differ');
      flag(first, group[0]!.no, 'contact_details_differ',
        `Numbers ${group.map((k) => k.no).join(', ')} are one person with different contact details; loaded from ${group[0]!.no}`);
    }

    const postCodeValid = isUkPostcode(first.postCode);
    if (!postCodeValid) {
      flags.add('postcode_invalid');
      flag(first, group[0]!.no, 'postcode_invalid', `Post Code "${first.postCode}"`);
    }

    // The person joined when their earliest number did.
    let joiningDate: string | null = null;
    for (const k of group) {
      if (k.row.joiningDate === '') continue;
      const d = parseUkDate(k.row.joiningDate);
      if (!d) {
        flags.add('joining_date_unreadable');
        flag(k.row, k.no, 'joining_date_unreadable', `Joining Date "${k.row.joiningDate}"`);
      } else if (!joiningDate || d < joiningDate) joiningDate = d;
    }

    const fullName = norm(`${first.forename} ${first.surname}`);
    const quarantined = group.some((k) => quarantineNumbers.has(k.no) || quarantineNames.has(norm(`${k.row.forename} ${k.row.surname}`)));
    if (quarantined) {
      flags.add('quarantined');
      flag(first, group[0]!.no, 'quarantined', `GAP-35: open member query for ${fullName} — loaded as quarantined`);
    }
    const paying = group.some((k) => norm(k.row.status) === 'paying');

    for (const k of group) memberIndexOf.set(k.no, members.length);
    members.push({
      sourceRow: first.sourceRow,
      title: blank(first.title),
      forename: blank(first.forename),
      surname: blank(first.surname),
      address1: blank(first.address1),
      address2: blank(first.address2),
      address3: blank(first.address3),
      postCode: blank(first.postCode),
      postCodeValid,
      telephone: blank(first.telephone),
      joiningDate,
      status: quarantined ? 'quarantined' : paying ? 'active' : 'lapsed',
      prizeDrawNos: group.map((k) => k.no),
      flags: [...flags],
    });
  }

  // Not merged, but worth a look: the same name at the same postcode.
  const byNamePostcode = new Map<string, number[]>();
  members.forEach((m, i) => {
    if (!m.surname || !m.postCode) return;
    const key = `${norm(m.forename ?? '')}|${norm(m.surname)}|${normPostcode(m.postCode)}`;
    byNamePostcode.set(key, [...(byNamePostcode.get(key) ?? []), i]);
  });
  for (const indexes of byNamePostcode.values()) {
    if (indexes.length < 2) continue;
    const nos = indexes.flatMap((i) => members[i]!.prizeDrawNos);
    for (const i of indexes) {
      const m = members[i]!;
      members[i] = { ...m, flags: [...m.flags, 'possible_same_person'] };
      findings.push({ sourceRow: m.sourceRow, prizeDrawNo: m.prizeDrawNos[0]!, flag: 'possible_same_person',
        detail: `Same name and postcode as another member (numbers ${nos.join(', ')}), with no "Also" note linking them` });
    }
  }

  // Each number.
  const numbers: PlannedNumber[] = [];
  for (const k of [...unique].sort((a, b) => a.no - b.no)) {
    const r = k.row;
    if (k.rowType === 'blank_reserved') {
      numbers.push({
        prizeDrawNo: k.no, sourceRow: r.sourceRow, rowType: 'blank_reserved', memberIndex: null,
        legacyAgent: blank(r.agent), legacyChannel: parseChannel(r.channel), legacyPaymentRaw: blank(r.paymentRaw),
        legacyAmountPence: null, legacyFrequency: null, legacyStatusText: blank(r.status), legacyInfo: blank(r.info),
        payments12m: null, total12mPence: null, observedFrequency: blank(r.observedFrequency), standingOrder: null,
      });
      continue;
    }

    const memberIndex = memberIndexOf.get(k.no)!;
    const numberFlags: LegacyFlag[] = [];
    const note = (f: LegacyFlag, detail: string) => {
      numberFlags.push(f);
      flag(r, k.no, f, detail);
    };

    const channel = parseChannel(r.channel);
    if (channel === 'unknown') note('channel_unknown', `Channel "${r.channel}"`);

    let amount: Pence | null = null;
    if (r.amount === '') note('amount_unknown', `GAP-20: no amount (Payment Type "${r.paymentRaw}")`);
    else if (!(amount = parsePounds(r.amount))) note('amount_unreadable', `Amount (parsed) "${r.amount}"`);

    const frequency = r.frequency === '' ? null : parseFrequency(r.frequency);
    if (r.frequency !== '' && !frequency) note('frequency_unknown', `Frequency (parsed) "${r.frequency}"`);
    if (frequency && r.observedFrequency !== '' && parseFrequency(r.observedFrequency) !== frequency) {
      note('observed_frequency_differs', `Register says ${frequency}; bank statements show "${r.observedFrequency}"`);
    }

    const total12m = r.total12m === '' ? null : parsePounds(r.total12m);
    if (r.total12m !== '' && total12m === null) note('observed_total_unreadable', `Total (12m) "${r.total12m}"`);
    const payments12m = /^\d+$/.test(r.payments12m) ? Number(r.payments12m) : null;

    const member = members[memberIndex]!;
    // GAP-04: a standing order still paying keeps running unchanged; recording
    // it lets bank matching recognise its amount and the jackpot estimate count
    // it. Agent-collected numbers have none (GAP-19 c), and a quarantined
    // person's money waits for their query to be answered.
    const standingOrder =
      norm(r.status) === 'paying' && channel === 'direct_bank' && amount !== null && frequency !== null && member.status !== 'quarantined'
        ? { amountPence: amount, frequency, annualBasisPence: pence(amount * PER_YEAR[frequency]) }
        : null;

    if (numberFlags.length > 0) members[memberIndex] = { ...member, flags: [...new Set([...member.flags, ...numberFlags])] };

    numbers.push({
      prizeDrawNo: k.no, sourceRow: r.sourceRow, rowType: 'member', memberIndex,
      legacyAgent: blank(r.agent), legacyChannel: channel, legacyPaymentRaw: blank(r.paymentRaw),
      legacyAmountPence: amount, legacyFrequency: frequency, legacyStatusText: blank(r.status), legacyInfo: blank(r.info),
      payments12m, total12mPence: total12m, observedFrequency: blank(r.observedFrequency), standingOrder,
    });
  }

  const counts: LegacyRegisterCounts = {
    rowsRead: rows.length,
    memberRows: numbers.filter((n) => n.rowType === 'member').length,
    blankReservedRows: numbers.filter((n) => n.rowType === 'blank_reserved').length,
    rejectedRows: rejected.length,
    people: members.length,
    peopleActive: members.filter((m) => m.status === 'active').length,
    peopleLapsed: members.filter((m) => m.status === 'lapsed').length,
    peopleQuarantined: members.filter((m) => m.status === 'quarantined').length,
    standingOrders: numbers.filter((n) => n.standingOrder).length,
    agentCollectedNumbers: numbers.filter((n) => n.legacyChannel === 'agent_collected').length,
  };

  // GAP-40: every row read is loaded or rejected, every member number has a
  // person, and the totals match what the register is known to hold.
  const reconciliationFailures: string[] = [];
  if (counts.rowsRead !== counts.memberRows + counts.blankReservedRows + counts.rejectedRows) {
    reconciliationFailures.push(
      `${counts.rowsRead} rows read ≠ ${counts.memberRows} member + ${counts.blankReservedRows} blank reserved + ${counts.rejectedRows} rejected`);
  }
  const numbersOnPeople = members.reduce((n, m) => n + m.prizeDrawNos.length, 0);
  if (numbersOnPeople !== counts.memberRows) {
    reconciliationFailures.push(`${numbersOnPeople} numbers held by people ≠ ${counts.memberRows} member rows`);
  }
  const expect = options.expect ?? {};
  for (const [label, want, got] of [
    ['rows', expect.rows, counts.rowsRead],
    ['member rows', expect.memberRows, counts.memberRows],
    ['blank reserved rows', expect.blankReservedRows, counts.blankReservedRows],
  ] as const) {
    if (want !== undefined && want !== got) reconciliationFailures.push(`expected ${want} ${label}, found ${got}`);
  }

  return {
    members,
    numbers,
    rejected: rejected.sort((a, b) => a.sourceRow - b.sourceRow),
    findings: findings.sort((a, b) => a.sourceRow - b.sourceRow),
    counts,
    reconciliationFailures,
    valuesSeen: {
      rowType: tally(rows, 'rowType'),
      status: tally(rows, 'status'),
      channel: tally(rows, 'channel'),
      agent: tally(rows, 'agent'),
      frequency: tally(rows, 'frequency'),
      observedFrequency: tally(rows, 'observedFrequency'),
    },
  };
}
