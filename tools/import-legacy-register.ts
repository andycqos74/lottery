#!/usr/bin/env tsx
/**
 * Load QOSFC's legacy member register — T-11. Run once, at switch-over.
 *
 * Reads the register exported from the spreadsheet (File → Save as CSV, or
 * the sheet pasted into a .tsv file), one row per prize draw number, with
 * the header row:
 *
 *   Prize Draw No | Title | Forename | Surname | Address 1 | Address 2 |
 *   Address 3 | Post Code | Telephone | Agent | Channel | Joining Date |
 *   Payment Type (raw) | Amount (parsed) | Frequency (parsed) | Info |
 *   Row Type | Status | Payments (12m) | Total (12m) | Observed Freq
 *
 * A DRY RUN unless --commit: it prints what would be loaded and writes the
 * exception report — every rejected row and every flag, with its spreadsheet
 * row number — beside the input (or to --report). Read that before
 * committing. With --commit the whole register loads in one transaction, or
 * nothing does.
 *
 * What the load means downstream:
 *   - A person (GAP-06) is one or more numbers joined by an "Also NNNN" note.
 *   - A number whose Status is PAYING, paid direct to the bank, with an amount
 *     and frequency, gets a standing order recorded (GAP-04: it keeps running
 *     at the bank). Bank matching then recognises its amount, and the jackpot
 *     estimate counts it.
 *   - A person with no PAYING number is loaded as lapsed.
 *   - GAP-13: a week after the load, every active player number with no
 *     numbers chosen gets RANDOM.ORG numbers, and a task to post them.
 *
 * The register holds real people's details: B-2 bars it from dev and CI. Do
 * not commit the file or the exception report to the repository.
 *
 * Usage:
 *   APP_DB_MIGRATION_URL=postgres://lottery_owner@<host>:5432/lottery_app \
 *   APP_DB_MIGRATION_PASSWORD_FILE=deploy/secrets/app_db_password \
 *   pnpm import:legacy-register <register.csv> [--commit] [--report <path>]
 *     [--expect-rows N] [--expect-members N] [--expect-blank N]
 *     [--quarantine 1304,1305] [--quarantine-name "Alan Henry"] [--no-gap-35]
 *     [--actor "Your Name"]
 *
 * --expect-* are the counts the register is known to hold (GAP-40); any that
 * differ stop the load. GAP-35's open queries (#1304; Alan Henry's rows) are
 * quarantined by default; --quarantine / --quarantine-name add to them, and
 * --no-gap-35 drops the defaults.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createPool } from '@qosfc/db';
import { importLegacyRegister, LegacyRegisterAlreadyLoadedError } from '../packages/activities/src/index.js';
import {
  formatPence,
  GAP_35_QUARANTINE,
  parseDelimited,
  planLegacyRegister,
  readLegacyRegister,
  type LegacyRegisterPlan,
} from '../packages/domain/src/index.js';

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
function values(flag: string): string[] {
  return argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]!] : []));
}
function count(flag: string): number | undefined {
  const v = values(flag)[0];
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new Error(`${flag} takes a whole number, got "${v}"`);
  return Number(v);
}

const takesValue = new Set(['--report', '--expect-rows', '--expect-members', '--expect-blank', '--quarantine', '--quarantine-name', '--actor']);
const file = argv.find((a, i) => !a.startsWith('--') && !takesValue.has(argv[i - 1] ?? ''));
if (!file) {
  console.error('Usage: pnpm import:legacy-register <register.csv> [--commit] — see tools/import-legacy-register.ts');
  process.exit(2);
}

const bytes = readFileSync(file);
const sourceFileHash = createHash('sha256').update(bytes).digest('hex');
const gap35 = !has('--no-gap-35');
const plan = planLegacyRegister(readLegacyRegister(parseDelimited(bytes.toString('utf8'))), {
  quarantineNumbers: [
    ...(gap35 ? GAP_35_QUARANTINE.numbers : []),
    ...values('--quarantine').flatMap((v) => v.split(',')).map((v) => Number(v.trim())),
  ],
  quarantineNames: [...(gap35 ? GAP_35_QUARANTINE.names : []), ...values('--quarantine-name')],
  expect: { rows: count('--expect-rows'), memberRows: count('--expect-members'), blankReservedRows: count('--expect-blank') },
});

printSummary(plan);
const reportPath = values('--report')[0] ?? join(dirname(file), `${basename(file).replace(/\.[^.]+$/, '')}.exceptions.csv`);
writeFileSync(reportPath, exceptionReport(plan));
console.log(`\nException report: ${reportPath} (${plan.rejected.length} rejected, ${plan.findings.length} to check)`);

if (plan.reconciliationFailures.length > 0) {
  console.error(`\nGAP-40 — the counts do not reconcile, so this register cannot be loaded:\n  ${plan.reconciliationFailures.join('\n  ')}`);
  process.exit(1);
}
if (!has('--commit')) {
  console.log('\nDry run — nothing written. Re-run with --commit to load.');
  process.exit(0);
}

const url = process.env['APP_DB_MIGRATION_URL'] ?? process.env['APP_DB_URL'];
if (!url) throw new Error('Set APP_DB_MIGRATION_URL (or APP_DB_URL) to load.');
const pool = createPool({
  connectionString: url,
  passwordFile: process.env['APP_DB_MIGRATION_PASSWORD_FILE'],
  applicationName: 'qosfc-legacy-register-import',
  max: 2,
});
try {
  const actorLabel = values('--actor')[0] ?? process.env['USER'] ?? 'legacy register import';
  const counts = await importLegacyRegister(pool, { plan, sourceFileHash, actorLabel });
  console.log(`\nLoaded: ${counts.people} people, ${counts.memberRows + counts.blankReservedRows} prize draw numbers, ${counts.standingOrders} standing orders. sha256 ${sourceFileHash}`);
} catch (error) {
  if (!(error instanceof LegacyRegisterAlreadyLoadedError)) throw error;
  console.error(`\n${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

function printSummary(p: LegacyRegisterPlan): void {
  const c = p.counts;
  const annual = p.numbers.reduce((sum, n) => sum + (n.standingOrder?.annualBasisPence ?? 0n), 0n);
  console.log(`Register ${file} (sha256 ${sourceFileHash.slice(0, 12)}…)`);
  console.log(`  rows read             ${c.rowsRead}`);
  console.log(`  member numbers        ${c.memberRows}  (${c.agentCollectedNumbers} agent-collected)`);
  console.log(`  blank reserved        ${c.blankReservedRows}`);
  console.log(`  rejected              ${c.rejectedRows}`);
  console.log(`  people                ${c.people}  (${c.peopleActive} active, ${c.peopleLapsed} lapsed, ${c.peopleQuarantined} quarantined)`);
  console.log(`  standing orders       ${c.standingOrders}  (${formatPence(annual as never)} a year)`);

  const byFlag: Record<string, number> = {};
  for (const f of p.findings) byFlag[f.flag] = (byFlag[f.flag] ?? 0) + 1;
  if (Object.keys(byFlag).length > 0) {
    console.log('\nTo check (flagged, still loaded):');
    for (const [flag, n] of Object.entries(byFlag).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${flag}`);
  }

  console.log('\nValues seen — check each is read the way you expect:');
  for (const [column, seen] of Object.entries(p.valuesSeen)) {
    const list = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([v, n]) => `${v === '' ? '(blank)' : JSON.stringify(v)} ×${n}`).join(', ');
    const more = Object.keys(seen).length > 12 ? `, … ${Object.keys(seen).length - 12} more` : '';
    console.log(`  ${column.padEnd(18)} ${list}${more}`);
  }
}

function exceptionReport(p: LegacyRegisterPlan): string {
  const cell = (v: string | number | null) => {
    const s = v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['Spreadsheet row', 'Prize Draw No', 'Outcome', 'Issue', 'Detail'].join(',')];
  for (const r of p.rejected) lines.push([r.sourceRow, r.prizeDrawNo, 'REJECTED — not loaded', 'rejected', r.reason].map(cell).join(','));
  for (const f of p.findings) lines.push([f.sourceRow, f.prizeDrawNo, 'loaded — check', f.flag, f.detail].map(cell).join(','));
  return `${lines.join('\n')}\n`;
}
