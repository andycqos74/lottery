#!/usr/bin/env tsx
/**
 * Opening credit for legacy standing orders — switch-over decision D2 (c),
 * gap G1 in docs/SWITCHOVER_DRY_RUN.md. Run once, at switch-over, after the
 * register is loaded and the draws are created.
 *
 * Reads the OLD lottery's bank statements — everything up to the cut-off,
 * ideally a full year so annual payers' last payment is in it — and works
 * out, for every prize draw number, how much it paid, how many of the old
 * lottery's weekly draws that covered, and how many whole weeks it has
 * already paid for that the old lottery never drew. Those weeks become
 * entries in the new draws from Draw 1 (packages/domain/src/opening-credit.ts
 * has the calculation).
 *
 *   --cutoff YYYY-MM-DD      the old lottery's last draw. Credits after it are
 *                            the new lottery's: upload those on the Bank
 *                            statements page, starting the day after.
 *   --first-draw YYYY-MM-DD  the new lottery's Draw 1.
 *   --old-draw-day DAY       the old lottery's draw day (e.g. saturday), when
 *                            the cut-off is not itself a draw day.
 *   --assign FILE            the exception report with its "assign" column
 *                            filled in: a prize draw number, or "ignore".
 *
 * Statement files are the bank's "TransactionHistory" CSV export (or the
 * canonical #statement CSV); several may be given, and rows repeated across
 * overlapping exports count once.
 *
 * A DRY RUN unless --commit: it prints a summary and writes two reports
 * beside the first statement (or into --report-dir):
 *   opening-credit-<cutoff>.csv             one row per number: paid, old
 *                                           draws covered, weeks carried, flags
 *   opening-credit-<cutoff>.exceptions.csv  credits it could not tie to one
 *                                           number — fill in "assign", pass
 *                                           it back with --assign
 * With --commit each number with weeks left gets one opening-credit payment
 * and the weeks are entered in the open draws. It refuses while credits are
 * unassigned (unless --allow-unresolved), and refuses if the system already
 * holds statement credits dated on or before the cut-off. Running it again
 * never credits a number twice.
 *
 * The statements and reports name real people: B-2 bars them from dev and
 * CI. Do not commit them to the repository.
 *
 * Usage:
 *   APP_DB_MIGRATION_URL=postgres://lottery_owner@<host>:5432/lottery_app \
 *   APP_DB_MIGRATION_PASSWORD_FILE=deploy/secrets/app_db_password \
 *   pnpm opening-credit --cutoff 2026-11-21 --first-draw 2026-11-27 <statement.csv>... \
 *     [--old-draw-day saturday] [--assign <exceptions.csv>] [--report-dir <dir>] \
 *     [--commit] [--allow-unresolved] [--actor "Your Name"]
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createPool } from '@qosfc/db';
import { parseCanonicalStatementCsv } from '../packages/adapters-live/src/bank-feed/csv-format.js';
import { looksLikeRealExportCsv, parseRealExportCsv } from '../packages/adapters-live/src/bank-feed/real-export-csv-format.js';
import {
  applyOpeningCredit,
  countImportedCreditsUpTo,
  existingOpeningCredits,
  loadOpeningCreditNumbers,
  OpeningCreditOverlapError,
  OpeningCreditUnresolvedError,
} from '../packages/activities/src/index.js';
import {
  formatPence,
  openingCreditExceptionReport,
  openingCreditReport,
  parseDelimited,
  pence,
  planOpeningCredit,
  readOpeningCreditAssignments,
  WEEKDAY_NAMES,
  weekdayOf,
  type OpeningCreditPlan,
  type OpeningCreditStatementLine,
} from '../packages/domain/src/index.js';

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const takesValue = new Set(['--cutoff', '--first-draw', '--old-draw-day', '--assign', '--report-dir', '--actor']);
const value = (flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const files = argv.filter((a, i) => !a.startsWith('--') && !takesValue.has(argv[i - 1] ?? ''));
const cutoff = value('--cutoff');
const firstDraw = value('--first-draw');
if (!cutoff || !firstDraw || files.length === 0) {
  console.error('Usage: pnpm opening-credit --cutoff YYYY-MM-DD --first-draw YYYY-MM-DD <statement.csv>... [--commit] — see tools/opening-credit.ts');
  process.exit(2);
}
let oldDrawWeekday: number | undefined;
const dayArg = value('--old-draw-day');
if (dayArg) {
  oldDrawWeekday = WEEKDAY_NAMES.findIndex((d) => d.toLowerCase().startsWith(dayArg.trim().toLowerCase().slice(0, 3)));
  if (oldDrawWeekday < 0) throw new Error(`--old-draw-day must be a day of the week, got "${dayArg}".`);
}

// ── Read the statements ─────────────────────────────────────────────────────
const sourceFileHashes: string[] = [];
const statementLines: OpeningCreditStatementLine[] = [];
for (const file of files) {
  const bytes = readFileSync(file);
  sourceFileHashes.push(createHash('sha256').update(bytes).digest('hex'));
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const rows = looksLikeRealExportCsv(firstLine) ? parseRealExportCsv(text).rows : parseCanonicalStatementCsv(text).rows;
  for (const r of rows) {
    statementLines.push({
      externalId: r.externalId,
      valueDate: r.valueDate,
      amountPence: pence(BigInt(r.amountPence.replace(/^-/, ''))),
      isCredit: r.isCredit,
      typeRaw: r.typeRaw,
      reference: r.extractedReference ?? null,
      description: r.description,
      name: r.extractedName ?? null,
    });
  }
  console.log(`Statement ${file}: ${rows.length} lines (sha256 ${sourceFileHashes.at(-1)!.slice(0, 12)}…)`);
}
const assignments = value('--assign') ? readOpeningCreditAssignments(parseDelimited(readFileSync(value('--assign')!, 'utf8'))) : undefined;

// ── Plan against the loaded register ────────────────────────────────────────
const url = process.env['APP_DB_MIGRATION_URL'] ?? process.env['APP_DB_URL'];
if (!url) throw new Error('Set APP_DB_MIGRATION_URL (or APP_DB_URL): the register must be loaded, and is read from the database.');
const pool = createPool({
  connectionString: url,
  passwordFile: process.env['APP_DB_MIGRATION_PASSWORD_FILE'],
  applicationName: 'qosfc-opening-credit',
  max: 2,
});

try {
  const numbers = await loadOpeningCreditNumbers(pool);
  if (numbers.length === 0) throw new Error('No member numbers are loaded. Load the legacy register first (pnpm import:legacy-register).');
  const plan = planOpeningCredit(statementLines, numbers, {
    cutoff,
    firstDraw,
    ...(oldDrawWeekday !== undefined ? { oldDrawWeekday } : {}),
    ...(assignments ? { assignments } : {}),
  });

  const { rows: draws } = await pool.query<{ draw_number: number; day: string }>(
    `SELECT draw_number, to_char(draw_date, 'YYYY-MM-DD') AS day
       FROM draw WHERE status = 'open' ORDER BY COALESCE(draw_at, draw_date::timestamptz), draw_number`,
  );
  const imported = await countImportedCreditsUpTo(pool, cutoff);
  const existing = await existingOpeningCredits(pool);

  printSummary(plan, numbers.length, draws, imported, existing.size);

  const reportDir = value('--report-dir') ?? dirname(files[0]!);
  const reportPath = join(reportDir, `opening-credit-${cutoff}.csv`);
  const exceptionsPath = join(reportDir, `opening-credit-${cutoff}.exceptions.csv`);
  writeFileSync(reportPath, openingCreditReport(plan));
  writeFileSync(exceptionsPath, openingCreditExceptionReport(plan));
  console.log(`\nReport:            ${reportPath}`);
  console.log(`Exception report:  ${exceptionsPath} (${plan.exceptions.length} to assign, ${plan.decided.length} decided)`);

  if (!has('--commit')) {
    console.log('\nDry run — nothing written. Re-run with --commit to credit the weeks.');
  } else {
    const result = await applyOpeningCredit(pool, {
      plan,
      sourceFileHashes,
      actorLabel: value('--actor') ?? process.env['USER'] ?? 'opening credit',
      allowUnresolved: has('--allow-unresolved'),
    });
    console.log(`\nCredited: ${result.numbersCredited} numbers, ${result.weeksCredited} weeks.`);
    if (result.alreadyCredited.length > 0) {
      const changed = result.alreadyCredited.filter((a) => a.weeksBefore !== a.weeksNow);
      console.log(`Already credited, left as they were: ${result.alreadyCredited.length}` +
        (changed.length > 0 ? ` — ${changed.length} would now come out differently: ${changed.slice(0, 20).map((c) => `#${c.prizeDrawNo} ${c.weeksBefore}→${c.weeksNow}`).join(', ')}` : ''));
    }
    if ('error' in result.allocation) {
      console.log(`Entries not placed yet: ${result.allocation.error}\nThe credits stand; each draw enters them when it runs, or once the cause is fixed.`);
    } else {
      console.log(`Entries placed: ${result.allocation.entriesPlaced}; weeks waiting for numbers or for more draws: ${result.allocation.weeksWaitingForDraws}.`);
    }
  }
} catch (error) {
  if (!(error instanceof OpeningCreditOverlapError || error instanceof OpeningCreditUnresolvedError || error instanceof RangeError)) throw error;
  console.error(`\n${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

function printSummary(
  p: OpeningCreditPlan,
  numbersLoaded: number,
  draws: readonly { draw_number: number; day: string }[],
  importedUpToCutoff: number,
  alreadyCredited: number,
): void {
  const t = p.totals;
  console.log(`\nCut-off (old lottery's last draw)  ${p.cutoff} (${WEEKDAY_NAMES[weekdayOf(p.cutoff)]})`);
  console.log(`Old lottery draws                  ${WEEKDAY_NAMES[p.oldDrawWeekday]}s — ${p.oldDraws.length} in the window` +
    (p.oldDraws.length > 0 ? ` (${p.oldDraws[0]} … ${p.oldDraws.at(-1)})` : ''));
  console.log(`Statement window                   ${p.windowStart ?? '—'} … ${p.windowEnd ?? '—'}`);
  console.log(`New lottery Draw 1                 ${p.firstDraw} (${WEEKDAY_NAMES[weekdayOf(p.firstDraw)]})`);
  console.log(`\n  member numbers loaded       ${numbersLoaded}`);
  console.log(`  credits matched             ${t.matchedCredits}  (${formatPence(t.matchedPence)})`);
  console.log(`  credits to assign           ${p.exceptions.length}`);
  console.log(`  left out                    ${p.ignored.afterCutoff} after the cut-off, ${p.ignored.agentLodgements} agent lodgements, ` +
    `${p.ignored.debits} debits, ${p.ignored.duplicates} repeated rows, ${p.ignored.assignedIgnore} marked "ignore"`);
  console.log(`  numbers with weeks left     ${t.numbersCredited}  (${t.weeks} weeks, ${formatPence(t.creditPence)})`);

  const byWeeks = new Map<number, number>();
  for (const l of p.lines) if (l.weeks > 0) byWeeks.set(l.weeks, (byWeeks.get(l.weeks) ?? 0) + 1);
  if (byWeeks.size > 0) {
    console.log('\nWeeks carried into the new lottery:');
    for (const [w, n] of [...byWeeks].sort((a, b) => a[0] - b[0])) console.log(`  ${String(w).padStart(3)} week${w === 1 ? ' ' : 's'}  ${n} number${n === 1 ? '' : 's'}`);
  }

  const byFlag: Record<string, number> = {};
  for (const l of p.lines) for (const f of l.flags) byFlag[f] = (byFlag[f] ?? 0) + 1;
  if (Object.keys(byFlag).length > 0) {
    console.log('\nTo check (in the report):');
    for (const [flag, n] of Object.entries(byFlag).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${flag}`);
  }

  const warnings = [...p.warnings];
  const first = draws[0];
  if (!first) warnings.push('No open draws exist yet: the credits would wait until draws are created.');
  else if (first.day !== p.firstDraw) warnings.push(`The first open draw is Draw ${first.draw_number} on ${first.day}, not ${p.firstDraw}.`);
  const longest = Math.max(0, ...p.lines.map((l) => l.weeks));
  if (draws.length > 0 && longest > draws.length) {
    warnings.push(`The longest credit is ${longest} weeks but only ${draws.length} draws are open: the rest wait until more draws are created.`);
  }
  if (importedUpToCutoff > 0) {
    warnings.push(`The system already holds ${importedUpToCutoff} statement credit(s) dated on or before the cut-off — --commit will refuse (they would be counted twice).`);
  }
  if (alreadyCredited > 0) warnings.push(`${alreadyCredited} number(s) already have an opening credit; --commit leaves them as they are.`);
  if (warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of warnings) console.log(`  - ${w}`);
  }
}
