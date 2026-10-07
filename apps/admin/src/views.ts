import { formatPence, jackpotPosition, pence, revenueFor, TICKET_PRICE_PENCE } from '@qosfc/domain';
import type {
  BankStatementDetail,
  BankStatementSummary,
  BankTransactionForReview,
  BankTransactionRow,
  DashboardCounts,
  DirectDebitCollectionRow,
  DirectDebitMandateRow,
  RunLogCategory,
  RunLogCounts,
  RunLogEntry,
  DrawEntrant,
  DrawSummary,
  EntryFundingDetail,
  HumanTask,
  JackpotInputs,
  MemberPage,
  MemberPayment,
  MemberSummary,
  MemberUpcomingEntry,
} from './db.js';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0;
         background: #f6f7f9; color: #1a1d23; }
  header { background: #16233f; color: #fff; padding: 0.9rem 1.5rem; display: flex;
           align-items: center; justify-content: space-between; }
  header a { color: #fff; text-decoration: none; font-weight: 600; }
  header nav a { margin-left: 1.25rem; color: #c7d2e6; font-weight: 400; font-size: 0.9rem; }
  header nav a:hover { color: #fff; }
  main { max-width: 980px; margin: 2rem auto; padding: 0 1.5rem; }
  .auth-shell main { max-width: 380px; margin-top: 4rem; }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; }
  .card { background: #fff; border: 1px solid #e2e5ea; border-radius: 8px; padding: 1.25rem 1.5rem; overflow-x: auto;
          margin-bottom: 1.25rem; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; }
  .stat { text-align: center; }
  .stat .n { font-size: 1.8rem; font-weight: 700; display: block; }
  .stat .l { font-size: 0.8rem; color: #5b6472; }
  .stat.warn .n { color: #b3261e; }
  label { display: block; font-size: 0.85rem; font-weight: 600; margin: 0.75rem 0 0.25rem; }
  input[type=email], input[type=password], input[type=text], input[type=number], input[type=date],
  input[type=datetime-local], input[type=time], select, textarea {
    width: 100%; padding: 0.55rem 0.65rem; border: 1px solid #cbd1db; border-radius: 6px; font-size: 0.95rem;
  }
  textarea { min-height: 4.5rem; font-family: inherit; }
  button { margin-top: 1.1rem; background: #16233f; color: #fff; border: none; border-radius: 6px;
           padding: 0.6rem 1.1rem; font-size: 0.95rem; cursor: pointer; }
  button:hover { background: #223258; }
  button.secondary { background: #fff; color: #16233f; border: 1px solid #cbd1db; }
  .error { background: #fdecea; color: #b3261e; border: 1px solid #f3c1bd; border-radius: 6px;
           padding: 0.6rem 0.8rem; margin-bottom: 0.75rem; font-size: 0.9rem; }
  .flash { background: #eaf6ec; color: #1e6b34; border: 1px solid #bfe3c6; border-radius: 6px;
           padding: 0.6rem 0.8rem; margin-bottom: 0.75rem; font-size: 0.9rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.55rem 0.5rem; border-bottom: 1px solid #eef0f3; }
  th { color: #5b6472; font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; }
  tr.overdue td { color: #b3261e; }
  a.row-link { color: #16233f; text-decoration: none; font-weight: 600; }
  a.row-link:hover { text-decoration: underline; }
  .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.75rem;
           background: #eef0f3; color: #444; }
  .muted { color: #5b6472; font-size: 0.88rem; }
  dl.kv { display: grid; grid-template-columns: 10rem 1fr; row-gap: 0.4rem; font-size: 0.9rem; }
  dl.kv dt { color: #5b6472; }
  dl.kv dd { margin: 0; }
`;

function csrfField(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />`;
}

function layout(opts: {
  title: string;
  body: string;
  user?: { displayName: string; csrf: string } | undefined;
  authShell?: boolean;
}): string {
  const nav = opts.user
    ? `<header>
         <a href="/">QOSFC Admin</a>
         <nav>
           <span class="muted" style="color:#c7d2e6">${escapeHtml(opts.user.displayName)}</span>
           <a href="/tasks">Tasks</a>
           <a href="/draws">Draws</a>
           <a href="/members">Members</a>
           <a href="/direct-debits">Direct Debits</a>
           <a href="/bank-statements">Bank statements</a>
           <a href="/log">Log</a>
           <form method="post" action="/logout" style="display:inline">
             ${csrfField(opts.user.csrf)}
             <button type="submit" class="secondary" style="margin:0 0 0 1.25rem;padding:0.25rem 0.7rem;font-size:0.85rem">Log out</button>
           </form>
         </nav>
       </header>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(opts.title)} — QOSFC Admin</title>
  <style>${STYLE}</style>
</head>
<body class="${opts.authShell ? 'auth-shell' : ''}">
  ${nav}
  <main>${opts.body}</main>
</body>
</html>`;
}

export function loginPage(opts: { error?: string }): string {
  return layout({
    title: 'Log in',
    authShell: true,
    body: `
      <h1>QOSFC Lottery — Admin</h1>
      <div class="card">
        ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
        <form method="post" action="/login">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" required autofocus autocomplete="username" />
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required autocomplete="current-password" />
          <button type="submit">Continue</button>
        </form>
      </div>
      <p class="muted">Individual named accounts only, with mandatory MFA (T-9.3). No shared logins.</p>
    `,
  });
}

export function mfaPage(opts: { error?: string }): string {
  return layout({
    title: 'Verification code',
    authShell: true,
    body: `
      <h1>Enter your verification code</h1>
      <div class="card">
        ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
        <form method="post" action="/login/mfa">
          <label for="code">6-digit code from your authenticator app</label>
          <input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autofocus autocomplete="one-time-code" />
          <button type="submit">Verify</button>
        </form>
      </div>
    `,
  });
}

export function dashboardPage(opts: { user: { displayName: string; csrf: string }; counts: DashboardCounts }): string {
  const { counts } = opts;
  return layout({
    title: 'Dashboard',
    user: opts.user,
    body: `
      <h1>Dashboard</h1>
      <div class="card stat-grid">
        <div class="stat ${counts.overdueTasks > 0 ? 'warn' : ''}">
          <span class="n">${counts.openTasks}</span><span class="l">Open tasks</span>
        </div>
        <div class="stat ${counts.overdueTasks > 0 ? 'warn' : ''}">
          <span class="n">${counts.overdueTasks}</span><span class="l">Overdue</span>
        </div>
        <div class="stat"><span class="n">${counts.members}</span><span class="l">Members</span></div>
        <div class="stat"><a href="/draws" style="color:inherit;text-decoration:none"><span class="n">${counts.draws}</span><span class="l">Draws</span></a></div>
      </div>
      <div class="card">
        <p>The human task inbox (GAP-43) is the day-to-day surface of this console — every process that
        stopped to wait for a person shows up here rather than requiring anyone to touch the Temporal Web UI.</p>
        <a href="/tasks"><button type="button">Open task inbox →</button></a>
      </div>
    `,
  });
}

function taskRow(task: HumanTask, showStatus: boolean): string {
  const overdue =
    task.status === 'open' && ((task.dueAt !== null && task.dueAt.getTime() < Date.now()) || task.escalationLevel > 0);
  const escalated =
    task.status === 'open' && task.escalationLevel > 0
      ? ` <span class="badge" style="background:#b3261e;color:#fff">escalated ×${task.escalationLevel}</span>`
      : '';
  return `<tr class="${overdue ? 'overdue' : ''}">
    <td><a class="row-link" href="/tasks/${task.id}">${escapeHtml(task.title)}</a>${task.requiresSecondApprover ? ' <span class="badge">dual approval</span>' : ''}${escalated}</td>
    <td><span class="badge">${escapeHtml(task.kind)}</span></td>
    ${showStatus ? `<td><span class="badge">${escapeHtml(task.status)}</span></td>` : ''}
    <td>${task.openedAt.toISOString().slice(0, 10)}</td>
    <td>${task.dueAt ? task.dueAt.toISOString().slice(0, 10) : '—'}</td>
  </tr>`;
}

export function tasksPage(opts: {
  user: { displayName: string; csrf: string };
  tasks: HumanTask[];
  filter: 'open' | 'resolved' | 'all';
}): string {
  const { filter } = opts;
  const showStatus = filter !== 'open';
  const rows = opts.tasks.map((t) => taskRow(t, showStatus)).join('\n');
  const tab = (label: string, href: string, active: boolean) =>
    `<a href="${href}" style="margin-right:1.25rem;${active ? 'font-weight:700;color:#16233f' : 'color:#5b6472'}">${label}</a>`;
  const tabs = `<p>${tab('Open', '/tasks', filter === 'open')}${tab('Resolved', '/tasks?status=resolved', filter === 'resolved')}${tab('All', '/tasks?status=all', filter === 'all')}</p>`;
  const heading = filter === 'open' ? 'Open tasks' : filter === 'resolved' ? 'Resolved tasks' : 'All tasks';
  const empty = filter === 'open' ? 'Nothing is waiting on a person right now.' : 'No tasks to show.';
  return layout({
    title: 'Task inbox',
    user: opts.user,
    body: `
      <h1>${heading}</h1>
      ${tabs}
      <div class="card">
        ${
          opts.tasks.length === 0
            ? `<p class="muted">${empty}</p>`
            : `<table>
                 <thead><tr><th>Title</th><th>Kind</th>${showStatus ? '<th>Status</th>' : ''}<th>Opened</th><th>Due</th></tr></thead>
                 <tbody>${rows}</tbody>
               </table>`
        }
      </div>
    `,
  });
}

const LONDON_DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatLondon(value: Date | null): string {
  return value ? LONDON_DATE_TIME.format(value) : '—';
}

function drawTitle(draw: DrawSummary): string {
  return draw.name ? `Draw ${draw.drawNumber} — ${draw.name}` : `Draw ${draw.drawNumber}`;
}

/**
 * #7: the jackpot for every draw. Settled draws show the figure settlement
 * recorded; anything not yet settled is estimated exactly the way the draw
 * workflow will compute it — this draw's prize share of its entries so far,
 * plus the rollover waiting from the last settled draw, never below the floor.
 */
function drawJackpot(draw: DrawSummary, inputs: JackpotInputs): { readonly pence: bigint; readonly estimate: boolean } {
  if (draw.jackpotPreDrawPence !== null) return { pence: draw.jackpotPreDrawPence, estimate: false };
  // Real entries so far plus the standing orders expected to have paid by then.
  const entries = (draw.entriesCount ?? draw.liveEntriesCount) + draw.expectedStandingOrderEntries;
  const contribution = (revenueFor(entries, TICKET_PRICE_PENCE) * BigInt(inputs.prizeBp)) / 10_000n;
  const position = jackpotPosition(pence(contribution), pence(inputs.pendingRolloverPence), pence(inputs.floorPence));
  return { pence: position.jackpotPreDrawPence, estimate: true };
}

function formatJackpot(j: { pence: bigint; estimate: boolean }): string {
  return `${formatPence(pence(j.pence))}${j.estimate ? ' <span class="muted">(est.)</span>' : ''}`;
}

/** Real entries, plus any standing-order entries expected but not yet paid for (open draws only). */
function entriesLabel(draw: DrawSummary): string {
  const entries = draw.entriesCount ?? draw.liveEntriesCount;
  return draw.expectedStandingOrderEntries > 0
    ? `${entries} <span class="muted">+ ${draw.expectedStandingOrderEntries} standing orders (est.)</span>`
    : String(entries);
}

function drawRow(draw: DrawSummary, inputs: JackpotInputs): string {
  return `<tr>
    <td><a class="row-link" href="/draws/${draw.id}">${escapeHtml(drawTitle(draw))}</a></td>
    <td><span class="badge">${escapeHtml(draw.status)}</span></td>
    <td>${draw.drawAt ? escapeHtml(formatLondon(draw.drawAt)) : draw.drawDate.toISOString().slice(0, 10)}</td>
    <td>${escapeHtml(formatLondon(draw.entriesCloseAt))}</td>
    <td>${entriesLabel(draw)}</td>
    <td>${formatJackpot(drawJackpot(draw, inputs))}</td>
    <td>${draw.winningNumbers ? draw.winningNumbers.join(' · ') : '—'}</td>
    <td>${draw.jackpotPaidPence !== null ? formatPence(pence(draw.jackpotPaidPence)) : '—'}</td>
    <td><a href="/draws/${draw.id}/entrants">Entrants</a></td>
  </tr>`;
}

export function drawsPage(opts: { user: { displayName: string; csrf: string }; draws: DrawSummary[]; jackpotInputs: JackpotInputs }): string {
  const rows = opts.draws.map((d) => drawRow(d, opts.jackpotInputs)).join('\n');
  const open = opts.draws.filter((d) => d.status === 'open');
  const openEntries = open.reduce((sum, d) => sum + d.liveEntriesCount, 0);
  const totalJackpot = opts.draws.reduce((sum, d) => sum + drawJackpot(d, opts.jackpotInputs).pence, 0n);
  return layout({
    title: 'Draws',
    user: opts.user,
    body: `
      <h1>Draws</h1>
      <p><a href="/draws/new"><button type="button">New draw</button></a></p>
      <div class="card">
        <div class="stat-grid">
          <div class="stat"><span class="n">${open.length}</span><span class="l">Open draws</span></div>
          <div class="stat"><span class="n">${openEntries}</span><span class="l">Entries in open draws</span></div>
          <div class="stat"><span class="n">${formatPence(pence(opts.jackpotInputs.pendingRolloverPence))}</span><span class="l">Rollover waiting</span></div>
          <div class="stat"><span class="n">${formatPence(pence(totalJackpot))}</span><span class="l">Total jackpot, all draws listed</span></div>
        </div>
      </div>
      <div class="card">
        ${
          opts.draws.length === 0
            ? '<p class="muted">No draws yet.</p>'
            : `<table>
                 <thead><tr><th>Draw</th><th>Status</th><th>Draw time</th><th>Entries close</th><th>Entries</th><th>Jackpot</th><th>Winning numbers</th><th>Paid</th><th></th></tr></thead>
                 <tbody>${rows}</tbody>
               </table>
               <p class="muted" style="margin-top:0.75rem">
                 Jackpots marked (est.) are not settled yet: this draw's 50% prize share of its entries so far (Direct Debit and
                 prepaid entries are made as soon as a draw is created) and of standing orders expected but not yet paid, plus the
                 rollover waiting from the last settled draw, never below the floor. Every open draw shows that same
                 rollover — only the next one to be run actually receives it.
               </p>`
        }
      </div>
    `,
  });
}

function memberOption(m: MemberSummary): string {
  const label = `${m.forename ?? ''} ${m.surname ?? ''}`.trim() || m.id;
  return `<option value="${m.id}">${escapeHtml(label)} (${m.entryCount} ${m.entryCount === 1 ? 'entry' : 'entries'})</option>`;
}

export function drawDetailPage(opts: {
  user: { displayName: string; csrf: string };
  draw: DrawSummary;
  jackpotInputs: JackpotInputs;
  members?: MemberSummary[];
  agents?: MemberSummary[];
  error?: string;
  flash?: string;
}): string {
  const { draw } = opts;
  const open = draw.status === 'open';
  const pastCutoff = draw.entriesCloseAt !== null && draw.entriesCloseAt.getTime() <= Date.now();
  const entriesDisplay = open
    ? `${draw.liveEntriesCount} (open)${draw.expectedStandingOrderEntries > 0 ? ` + ${draw.expectedStandingOrderEntries} expected from standing orders not yet paid` : ''}`
    : String(draw.entriesCount ?? draw.liveEntriesCount);
  const jackpot = drawJackpot(draw, opts.jackpotInputs);
  const meta = [
    ['Name', draw.name ?? '—'],
    ['Status', draw.status],
    ['Draw time', draw.drawAt ? formatLondon(draw.drawAt) : draw.drawDate.toISOString().slice(0, 10)],
    ['Entries close', draw.entriesCloseAt ? `${formatLondon(draw.entriesCloseAt)}${open && pastCutoff ? ' (closed)' : ''}` : '—'],
    ['Entries', entriesDisplay],
    ['Winning numbers', draw.winningNumbers ? draw.winningNumbers.join(' · ') : '—'],
    ['Rollover in', draw.rolloverInPence !== null ? formatPence(pence(draw.rolloverInPence)) : '—'],
    [jackpot.estimate ? 'Jackpot (estimated)' : 'Jackpot pre-draw', formatPence(pence(jackpot.pence))],
    ['Winners', draw.winnersCount !== null ? String(draw.winnersCount) : '—'],
    ['Jackpot paid', draw.jackpotPaidPence !== null ? formatPence(pence(draw.jackpotPaidPence)) : '—'],
    ['Rollover out', draw.rolloverOutPence !== null ? formatPence(pence(draw.rolloverOutPence)) : '—'],
    ['Workflow', draw.workflowId ?? '—'],
    ['Drawn at', draw.drawnAt ? draw.drawnAt.toISOString() : '—'],
    ['Settled at', draw.settledAt ? draw.settledAt.toISOString() : '—'],
  ]
    .map(([k, v]) => `<dt>${escapeHtml(k!)}</dt><dd>${escapeHtml(v!)}</dd>`)
    .join('');

  const renameForm = `
    <form method="post" action="/draws/${draw.id}/name" style="display:flex;gap:0.5rem;align-items:flex-end;margin-top:1rem">
      ${csrfField(opts.user.csrf)}
      <div style="flex:1">
        <label for="drawName" style="margin-top:0">Draw name</label>
        <input type="text" id="drawName" name="name" maxlength="120" value="${escapeHtml(draw.name ?? '')}" placeholder="e.g. Christmas Special" />
      </div>
      <button type="submit" class="secondary" style="margin-top:0">Save name</button>
    </form>`;

  let openSection = '';
  if (open) {
    const members = opts.members ?? [];
    const agents = opts.agents ?? [];
    const addEntry = pastCutoff
      ? `<p class="muted">Entries closed at ${escapeHtml(formatLondon(draw.entriesCloseAt))} — no more entries can be added to this draw.</p>`
      : members.length === 0
        ? `<p class="muted">No members yet — <a href="/members">add one</a> first.</p>`
        : `<form method="post" action="/draws/${draw.id}/entries">
             ${csrfField(opts.user.csrf)}
             <label for="memberId">Member</label>
             <select id="memberId" name="memberId" required>${members.map(memberOption).join('')}</select>
             <label for="selection">Numbers (four, 1&ndash;20)</label>
             <input type="text" id="selection" name="selection" required placeholder="2, 4, 5, 14" />
             <button type="submit">Add entry</button>
           </form>`;
    const manualTicket =
      agents.length === 0
        ? `<p class="muted">No agent members yet — <a href="/members">add one</a> first (Type: Agent).</p>`
        : `<form method="post" action="/draws/${draw.id}/manual-tickets" id="manual-ticket-form">
             ${csrfField(opts.user.csrf)}
             <label for="agentMemberId">Agent</label>
             <select id="agentMemberId" name="agentMemberId" required>${agents.map(memberOption).join('')}</select>
             <p class="muted" style="margin:0.2rem 0 0.6rem">
               The ticket is attributed to the agent, not the player — the player has no account
               and QOSFC cannot contact them directly. If it wins, notification goes to the agent.
             </p>
             <label for="physicalTicketNumber">Physical ticket number</label>
             <input type="text" id="physicalTicketNumber" name="physicalTicketNumber" required placeholder="e.g. 4471" />
             <label for="purchaseDate">Purchase date</label>
             <input type="date" id="purchaseDate" name="purchaseDate" required />
             <label for="weeks">Number of weeks</label>
             <input type="number" id="weeks" name="weeks" required min="1" max="104" step="1" value="1" />
             <label for="amountDisplay">Amount paid</label>
             <input type="text" id="amountDisplay" value="${formatPence(TICKET_PRICE_PENCE)}" readonly tabindex="-1" aria-describedby="amountHint" />
             <p class="muted" id="amountHint" style="margin:0.2rem 0 0">Worked out from the number of weeks at ${formatPence(TICKET_PRICE_PENCE)} a week.</p>
             <fieldset style="border:none;padding:0;margin:0.5rem 0">
               <label><input type="radio" name="selectionMode" value="random" checked /> Pick random numbers</label>
               <label><input type="radio" name="selectionMode" value="manual" /> Enter numbers from the ticket</label>
               <input type="text" name="selection" placeholder="2, 4, 5, 14" />
             </fieldset>
             <label style="font-weight:400"><input type="checkbox" name="confirmPaid" value="yes" required /> I confirm the money for this ticket has been paid</label>
             <button type="submit">Record ticket</button>
           </form>
           <p class="muted" style="margin:0.4rem 0 0">
             Each week bought is one prepaid entry (GAP-17): ${pastCutoff ? 'entries for this draw have closed, so the first is used by the next open draw' : 'the first goes into this draw now'},
             and the rest go into the following draws straight away, one each — any beyond the draws created so far are entered as new draws are added.
           </p>
           <script>
           (function(){
             var weeks = document.getElementById('weeks');
             var amount = document.getElementById('amountDisplay');
             function update(){
               var n = parseInt(weeks.value, 10);
               amount.value = n > 0 ? '£' + (n * ${Number(TICKET_PRICE_PENCE)} / 100).toFixed(2) : '';
             }
             weeks.addEventListener('input', update);
             update();
           })();
           </script>`;

    openSection = `
      <div class="card">
        ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
        ${opts.flash ? `<div class="flash">${escapeHtml(opts.flash)}</div>` : ''}
        <h2 style="font-size:1.05rem;margin-top:0">Add entry</h2>
        ${addEntry}
        <h2 style="font-size:1.05rem;margin-top:1.5rem">Record a physical/agent ticket</h2>
        ${manualTicket}
        <form method="post" action="/draws/${draw.id}/generate-entries" style="margin-top:1.25rem">
          ${csrfField(opts.user.csrf)}
          <button type="submit">Generate standing-order &amp; Direct Debit entries now</button>
        </form>
        <p class="muted" style="margin:0.4rem 0 0">
          Direct Debit members and prepaid weeks (card blocks, physical tickets, standing-order money matched from
          bank statements) are entered as soon as a draw is created, and again after each purchase or statement
          import. Running the draw re-checks automatically, so this button is only a manual top-up.
        </p>
        <form method="post" action="/draws/${draw.id}/run" style="margin-top:1.25rem">
          ${csrfField(opts.user.csrf)}
          <button type="submit">Close entries &amp; run this draw →</button>
        </form>
      </div>
    `;
  } else if (opts.error || opts.flash) {
    openSection = `<div class="card">
        ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
        ${opts.flash ? `<div class="flash">${escapeHtml(opts.flash)}</div>` : ''}
      </div>`;
  }

  return layout({
    title: drawTitle(draw),
    user: opts.user,
    body: `
      <p><a class="muted" href="/draws">← Back to draws</a></p>
      <h1>${escapeHtml(drawTitle(draw))}</h1>
      <div class="card">
        <dl class="kv">${meta}</dl>
        <p style="margin:0.75rem 0 0"><a href="/draws/${draw.id}/entrants">View entrants →</a></p>
        ${renameForm}
      </div>
      ${openSection}
    `,
  });
}

export interface NewDrawFormValues {
  readonly mode: 'one_off' | 'recurring';
  readonly name: string;
  readonly drawNumber: string;
  readonly drawAt: string;
  readonly entriesCloseAt: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly recurrence: string;
  readonly drawTime: string;
  readonly cutoffHours: string;
}

export function newDrawPage(opts: { user: { displayName: string; csrf: string }; values: NewDrawFormValues; error?: string }): string {
  const v = opts.values;
  const recurrenceOption = (value: string, label: string) =>
    `<option value="${value}" ${v.recurrence === value ? 'selected' : ''}>${label}</option>`;
  return layout({
    title: 'New draw',
    user: opts.user,
    body: `
      <p><a class="muted" href="/draws">← Back to draws</a></p>
      <h1>New draw</h1>
      <div class="card">
        ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
        <form method="post" action="/draws" id="new-draw-form">
          ${csrfField(opts.user.csrf)}
          <fieldset style="border:none;padding:0;margin:0">
            <label style="font-weight:400;display:inline-block;margin-right:1.25rem"><input type="radio" name="mode" value="one_off" ${v.mode === 'one_off' ? 'checked' : ''} /> One-off draw</label>
            <label style="font-weight:400;display:inline-block"><input type="radio" name="mode" value="recurring" ${v.mode === 'recurring' ? 'checked' : ''} /> Recurring draws</label>
          </fieldset>

          <label for="name">Draw name <span class="muted">(optional)</span></label>
          <input type="text" id="name" name="name" maxlength="120" value="${escapeHtml(v.name)}" placeholder="e.g. Christmas Special" />

          <label for="drawNumber" id="drawNumberLabel">${v.mode === 'recurring' ? 'First draw number' : 'Draw number'}</label>
          <input type="number" id="drawNumber" name="drawNumber" required min="1" value="${escapeHtml(v.drawNumber)}" />

          <div id="one-off-fields">
            <label for="drawAt">Draw date and time</label>
            <input type="datetime-local" id="drawAt" name="drawAt" value="${escapeHtml(v.drawAt)}" />
            <label for="entriesCloseAt">Entries close</label>
            <input type="datetime-local" id="entriesCloseAt" name="entriesCloseAt" value="${escapeHtml(v.entriesCloseAt)}" />
            <p class="muted" style="margin:0.3rem 0 0">No entries are accepted after this time.</p>
          </div>

          <div id="recurring-fields">
            <label for="startDate">First draw date</label>
            <input type="date" id="startDate" name="startDate" value="${escapeHtml(v.startDate)}" />
            <label for="endDate">Last possible draw date</label>
            <input type="date" id="endDate" name="endDate" value="${escapeHtml(v.endDate)}" />
            <label for="recurrence">Repeats</label>
            <select id="recurrence" name="recurrence">
              ${recurrenceOption('weekly', 'Every week')}
              ${recurrenceOption('fortnightly', 'Every two weeks')}
              ${recurrenceOption('monthly', 'Every month (same day of month)')}
            </select>
            <label for="drawTime">Draw time</label>
            <input type="time" id="drawTime" name="drawTime" value="${escapeHtml(v.drawTime)}" />
            <label for="cutoffHours">Entries close (hours before each draw)</label>
            <input type="number" id="cutoffHours" name="cutoffHours" min="0" max="336" step="1" value="${escapeHtml(v.cutoffHours)}" />
            <p class="muted" style="margin:0.3rem 0 0">e.g. 10 closes entries at 02:00 for a 12:00 draw. Every draw in the series is created now, each numbered one after the last.</p>
          </div>

          <button type="submit" id="createButton">${v.mode === 'recurring' ? 'Create draws' : 'Create draw'}</button>
        </form>
        <p class="muted">All times are UK time. Nothing is drawn until you run a draw from its page.</p>
      </div>
      <script>
      (function(){
        var oneOff = document.getElementById('one-off-fields');
        var recurring = document.getElementById('recurring-fields');
        var numberLabel = document.getElementById('drawNumberLabel');
        var button = document.getElementById('createButton');
        function update(){
          var isRecurring = document.querySelector('input[name=mode]:checked').value === 'recurring';
          oneOff.style.display = isRecurring ? 'none' : '';
          recurring.style.display = isRecurring ? '' : 'none';
          oneOff.querySelectorAll('input').forEach(function(el){ el.required = !isRecurring; });
          recurring.querySelectorAll('input,select').forEach(function(el){ el.required = isRecurring; });
          numberLabel.textContent = isRecurring ? 'First draw number' : 'Draw number';
          button.textContent = isRecurring ? 'Create draws' : 'Create draw';
        }
        document.querySelectorAll('input[name=mode]').forEach(function(r){ r.addEventListener('change', update); });
        update();
      })();
      </script>
    `,
  });
}

function memberName(m: { forename: string | null; surname: string | null }): string {
  return `${m.forename ?? ''} ${m.surname ?? ''}`.trim() || '—';
}

function memberRow(m: MemberSummary): string {
  return `<tr>
    <td><a class="row-link" href="/members/${m.id}">${escapeHtml(memberName(m))}</a></td>
    <td><span class="badge">${escapeHtml(m.status)}</span></td>
    <td>${escapeHtml(m.memberType)}</td>
    <td>${m.entryCount}</td>
  </tr>`;
}

export function membersPage(opts: {
  user: { displayName: string; csrf: string };
  members: MemberSummary[];
  error?: string;
  flash?: string;
}): string {
  const rows = opts.members.map(memberRow).join('\n');
  return layout({
    title: 'Members',
    user: opts.user,
    body: `
      <h1>Members</h1>
      <div class="card">
        ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
        ${opts.flash ? `<div class="flash">${escapeHtml(opts.flash)}</div>` : ''}
        <form method="post" action="/members">
          ${csrfField(opts.user.csrf)}
          <label for="forename">Forename</label>
          <input type="text" id="forename" name="forename" required />
          <label for="surname">Surname</label>
          <input type="text" id="surname" name="surname" required />
          <label for="memberType">Type</label>
          <select id="memberType" name="memberType">
            <option value="player" selected>Player</option>
            <option value="agent">Agent</option>
          </select>
          <p class="muted" style="margin:0.2rem 0 0.6rem">
            Agent: sells physical tickets to players who have no account of their own — see
            "Record a physical/agent ticket" on an open draw. Contact details recorded here are
            who a winning physical ticket notifies.
          </p>
          <button type="submit">Add member</button>
        </form>
      </div>
      <div class="card">
        ${
          opts.members.length === 0
            ? '<p class="muted">No members yet.</p>'
            : `<table>
                 <thead><tr><th>Name</th><th>Status</th><th>Type</th><th>Entries</th></tr></thead>
                 <tbody>${rows}</tbody>
               </table>`
        }
      </div>
    `,
  });
}

const FUNDING_LABELS: Record<string, string> = {
  direct_debit: 'DD',
  balance: 'Added by admin',
  agent: 'Agent',
};

/** How an entry is paid for (#16): "x of n" for paid weeks, "DD" for Direct Debit. */
function fundingLabel(e: EntryFundingDetail): string {
  if (e.paidIndex !== null && e.paidWeeks !== null) return `${e.paidIndex} of ${e.paidWeeks}`;
  return FUNDING_LABELS[e.funding] ?? e.funding;
}

function numbersLabel(selection: readonly number[]): string {
  return selection.join(' · ');
}

function entrantRow(e: DrawEntrant): string {
  const entries = e.entries
    .map((entry) => `<div>${numbersLabel(entry.selection)} <span class="badge">${escapeHtml(fundingLabel(entry))}</span></div>`)
    .join('');
  return `<tr>
    <td><a class="row-link" href="/members/${e.memberId}">${escapeHtml(memberName(e))}</a>${e.memberType === 'agent' ? ' <span class="badge">agent</span>' : ''}</td>
    <td>${e.email ? escapeHtml(e.email) : '<span class="muted">—</span>'}</td>
    <td>${e.entries.length}</td>
    <td>${entries}</td>
  </tr>`;
}

/** GitHub #16: who is entered in a draw. */
export function drawEntrantsPage(opts: { user: { displayName: string; csrf: string }; draw: DrawSummary; entrants: readonly DrawEntrant[] }): string {
  const { draw, entrants } = opts;
  const entries = entrants.reduce((sum, e) => sum + e.entries.length, 0);
  return layout({
    title: `${drawTitle(draw)} — entrants`,
    user: opts.user,
    body: `
      <p><a class="muted" href="/draws">← Back to draws</a> · <a class="muted" href="/draws/${draw.id}">${escapeHtml(drawTitle(draw))}</a></p>
      <h1>${escapeHtml(drawTitle(draw))} — entrants</h1>
      <p class="muted">${draw.drawAt ? escapeHtml(formatLondon(draw.drawAt)) : draw.drawDate.toISOString().slice(0, 10)} · <span class="badge">${escapeHtml(draw.status)}</span>
        · ${entrants.length} ${entrants.length === 1 ? 'member' : 'members'}, ${entries} ${entries === 1 ? 'entry' : 'entries'}</p>
      <div class="card">
        ${
          entrants.length === 0
            ? '<p class="muted">Nobody is entered in this draw yet.</p>'
            : `<table>
                 <thead><tr><th>Member</th><th>Email</th><th>Entries</th><th>Numbers &amp; paid draws</th></tr></thead>
                 <tbody>${entrants.map(entrantRow).join('\n')}</tbody>
               </table>
               <p class="muted" style="margin-top:0.75rem">
                 "x of n": this draw is the xth of the n draws paid for on those numbers (card, physical ticket or
                 standing order). DD: entered by Direct Debit.
               </p>`
        }
      </div>
    `,
  });
}

const CHANNEL_LABELS: Record<string, string> = {
  so_fps: 'Standing order',
  giro: 'Giro',
  branch_cash: 'Branch cash',
  card: 'Card',
  direct_debit: 'Direct Debit',
  agent_cash: 'Agent / physical ticket',
};

function paymentRow(p: MemberPayment): string {
  return `<tr>
    <td>${p.receivedDate.toISOString().slice(0, 10)}</td>
    <td>${escapeHtml(CHANNEL_LABELS[p.channel] ?? p.channel)}</td>
    <td>${formatPence(pence(p.amountPence))}</td>
    <td>${p.lineSelection ? numbersLabel(p.lineSelection) : '<span class="muted">—</span>'}</td>
    <td><span class="badge">${escapeHtml(p.status)}</span></td>
    <td>${p.reference ? escapeHtml(p.reference) : '<span class="muted">—</span>'}</td>
  </tr>`;
}

function upcomingRow(e: MemberUpcomingEntry): string {
  const title = e.drawName ? `Draw ${e.drawNumber} — ${e.drawName}` : `Draw ${e.drawNumber}`;
  return `<tr>
    <td><a class="row-link" href="/draws/${e.drawId}/entrants">${escapeHtml(title)}</a></td>
    <td>${e.drawAt ? escapeHtml(formatLondon(e.drawAt)) : e.drawDate.toISOString().slice(0, 10)}</td>
    <td><span class="badge">${escapeHtml(e.drawStatus)}</span></td>
    <td>${numbersLabel(e.selection)}</td>
    <td>${escapeHtml(fundingLabel(e))}</td>
  </tr>`;
}

/** GitHub #17: one member — details, payments, and the draws not yet run that they are entered in. */
const CONTACT_LABELS: Record<string, string> = { post: 'Post', email: 'Email', phone: 'Phone', via_agent: 'Via their agent' };

function postalAddress(p: MemberPage['profile']): string {
  const parts = [p.address1, p.address2, p.address3, p.county, p.postCode].filter((v): v is string => Boolean(v));
  return parts.length > 0 ? parts.join(', ') : '—';
}

/** GAP-05: email, telephone and postal address, all optional. */
function contactForm(csrf: string, p: MemberPage['profile']): string {
  const field = (name: string, label: string, value: string | null, type = 'text') =>
    `<label for="${name}">${escapeHtml(label)}</label>
     <input type="${type}" id="${name}" name="${name}" value="${escapeHtml(value ?? '')}" />`;
  const options = Object.entries(CONTACT_LABELS)
    .map(([v, l]) => `<option value="${v}"${p.preferredContact === v ? ' selected' : ''}>${escapeHtml(l)}</option>`)
    .join('');
  return `
    <details${p.email ? '' : ' open'}>
      <summary style="cursor:pointer;font-weight:600">Edit contact details</summary>
      ${p.email ? '' : '<p class="muted">No email address on record. If this member wins, a task is raised to contact them by post (GAP-05).</p>'}
      <form method="post" action="/members/${p.id}/contact">
        ${csrfField(csrf)}
        ${field('email', 'Email', p.email, 'email')}
        ${field('telephone', 'Telephone', p.telephone, 'tel')}
        ${field('address1', 'Address line 1', p.address1)}
        ${field('address2', 'Address line 2', p.address2)}
        ${field('address3', 'Town', p.address3)}
        ${field('county', 'County', p.county)}
        ${field('postCode', 'Postcode', p.postCode)}
        <label for="preferredContact">Preferred contact</label>
        <select id="preferredContact" name="preferredContact">${options}</select>
        <p class="muted" style="margin:0.2rem 0 0.6rem">Every field is optional; leave one blank to clear it.</p>
        <button type="submit">Save contact details</button>
      </form>
    </details>`;
}

const SELECTION_SOURCE_LABELS: Record<string, string> = {
  member_chosen: 'Member',
  quick_pick: 'Quick pick',
  randomly_allocated: 'Random (none chosen, GAP-13)',
};

function lineRow(csrf: string, memberId: string, line: MemberPage['lines'][number]): string {
  return `<tr>
    <td>${line.prizeDrawNo}</td>
    <td>${line.slot}</td>
    <td>${escapeHtml(numbersLabel(line.selection))}</td>
    <td>${escapeHtml(SELECTION_SOURCE_LABELS[line.source] ?? line.source)}</td>
    <td>
      <form method="post" action="/members/${memberId}/numbers" style="display:flex;gap:.4rem;align-items:center;margin:0">
        ${csrfField(csrf)}
        <input type="hidden" name="prizeDrawNo" value="${line.prizeDrawNo}" />
        <input type="hidden" name="slot" value="${line.slot}" />
        <input type="text" name="numbers" required placeholder="e.g. 3 7 12 18" aria-label="New numbers" style="width:9rem;margin:0" />
        <button type="submit">Change</button>
      </form>
    </td>
  </tr>`;
}

const LOG_STYLES: Record<RunLogCategory, { label: string; style: string }> = {
  success: { label: 'Success', style: 'background:#eaf6ec;color:#1e6b34' },
  info: { label: 'Info', style: 'background:#eef1f6;color:#3b4a66' },
  error: { label: 'Error', style: 'background:#b3261e;color:#fff' },
};

/** One line per finished workflow run (db/migrations/0023), newest first. */
export function runLogPage(opts: {
  user: { displayName: string; csrf: string };
  entries: readonly RunLogEntry[];
  counts: RunLogCounts;
  category?: RunLogCategory;
  includeQuiet: boolean;
}): string {
  const href = (category: RunLogCategory | undefined, quiet: boolean) => {
    const params = [category ? `category=${category}` : '', quiet ? 'quiet=1' : ''].filter(Boolean).join('&');
    return `/log${params ? `?${params}` : ''}`;
  };
  const tab = (label: string, category: RunLogCategory | undefined) =>
    `<a href="${href(category, opts.includeQuiet)}" style="margin-right:1.25rem;${opts.category === category ? 'font-weight:700;color:#16233f' : 'color:#5b6472'}">${label}</a>`;
  const row = (e: RunLogEntry) => {
    const c = LOG_STYLES[e.category];
    return `<tr${e.quiet ? ' class="muted"' : ''}>
      <td style="white-space:nowrap">${escapeHtml(formatLondon(e.closedAt))}</td>
      <td><span class="badge" style="${c.style}">${c.label}</span></td>
      <td title="${escapeHtml(e.workflowId)}">${escapeHtml(e.message)}</td>
    </tr>`;
  };
  return layout({
    title: 'Log',
    user: opts.user,
    body: `
      <h1>Log</h1>
      <div class="card">
        <p>Every background job (Temporal workflow run), in a sentence, as it finishes. Last 24 hours:
          <strong>${opts.counts.error}</strong> error${opts.counts.error === 1 ? '' : 's'},
          ${opts.counts.success} success${opts.counts.success === 1 ? '' : 'es'}, ${opts.counts.info} info,
          and ${opts.counts.quiet} routine check${opts.counts.quiet === 1 ? '' : 's'} with nothing to do.</p>
        <p>${tab('All', undefined)}${tab('Errors', 'error')}${tab('Success', 'success')}${tab('Info', 'info')}
          <a href="${href(opts.category, !opts.includeQuiet)}" style="color:#5b6472">${opts.includeQuiet ? 'Hide' : 'Show'} routine checks with nothing to do</a></p>
        ${
          opts.entries.length === 0
            ? '<p class="muted">Nothing logged yet.</p>'
            : `<table><thead><tr><th>Finished</th><th></th><th>What happened</th></tr></thead><tbody>${opts.entries.map(row).join('')}</tbody></table>`
        }
      </div>
    `,
  });
}

const DD_STATUS_LABELS: Record<string, string> = {
  pending: 'Awaiting bank confirmation',
  active: 'Active',
  cancelled: 'Cancelled',
  failed: 'Failed at the bank',
};
const DD_END_LABELS: Record<string, string> = {
  member_cancelled: 'cancelled by the member',
  admin_cancelled: 'cancelled by staff',
  payer_cancelled_at_bank: 'cancelled at their bank',
  mandate_failed: 'refused by their bank',
  collection_failed: 'two failed collections',
  refund_claim: 'refund claim',
  replaced: 'replaced by a new Direct Debit',
};
const DD_COLLECTION_LABELS: Record<string, string> = {
  scheduled: 'Scheduled',
  submitted: 'Sent to bank',
  collected: 'Collected',
  failed: 'Failed',
  rejected: 'Rejected by bank',
  cancelled: 'Called off',
  refunded: 'Refunded (claim)',
};

function ddCollectionRow(c: DirectDebitCollectionRow, withMember: boolean): string {
  return `<tr>
    ${withMember ? `<td><a class="row-link" href="/members/${c.memberId}">${escapeHtml(c.memberName)}</a></td>` : ''}
    <td>${escapeHtml(c.collectionDate)}${c.attempt > 1 ? ' <span class="badge">retry</span>' : ''}</td>
    <td>${formatPence(pence(c.amountPence))}</td>
    <td>${c.draws}</td>
    <td>${escapeHtml(DD_COLLECTION_LABELS[c.status] ?? c.status)}${c.failureReason ? ` <span class="muted">— ${escapeHtml(c.failureReason)}</span>` : ''}</td>
  </tr>`;
}

function ddStatus(dd: DirectDebitMandateRow): string {
  if (!dd.active) {
    return `Ended ${escapeHtml(formatLondon(dd.endedAt))}${dd.endReason ? ` — ${escapeHtml(DD_END_LABELS[dd.endReason] ?? dd.endReason)}` : ''}${
      dd.bureauCancelPending ? ' <span class="badge">bank cancellation pending</span>' : ''
    }`;
  }
  return escapeHtml(DD_STATUS_LABELS[dd.mandateStatus] ?? dd.mandateStatus);
}

/** A member's Direct Debits on their page, with collections and a cancel button for live ones. */
function memberDirectDebits(csrf: string, memberId: string, dds: readonly DirectDebitMandateRow[]): string {
  if (dds.length === 0) return '<p class="muted">No Direct Debits.</p>';
  return dds
    .map(
      (dd) => `<div style="margin-bottom:1rem">
        <dl class="kv">
          <dt>Numbers</dt><dd>${dd.selection ? escapeHtml(numbersLabel(dd.selection)) : '—'}</dd>
          <dt>Mandate</dt><dd>${escapeHtml(dd.mandateRef ?? '—')}</dd>
          <dt>Status</dt><dd>${ddStatus(dd)}</dd>
          <dt>Set up</dt><dd>${escapeHtml(formatLondon(dd.createdAt))}${dd.confirmedAt ? ` · confirmed ${escapeHtml(formatLondon(dd.confirmedAt))}` : ''}</dd>
        </dl>
        ${
          dd.collections.length > 0
            ? `<table><thead><tr><th>Collection date</th><th>Amount</th><th>Draws</th><th>Result</th></tr></thead>
                 <tbody>${dd.collections.map((c) => ddCollectionRow(c, false)).join('')}</tbody></table>`
            : '<p class="muted">No collections yet.</p>'
        }
        ${
          dd.active
            ? `<form method="post" action="/members/${memberId}/direct-debits/${dd.id}/cancel" onsubmit="return confirm('Cancel this Direct Debit? Its entries in draws still taking entries are withdrawn, except any already paid for, and it is cancelled with the bank.');">
                 ${csrfField(csrf)}
                 <button type="submit">Cancel this Direct Debit</button>
               </form>`
            : ''
        }
      </div>`,
    )
    .join('<hr>');
}

/** Every Direct Debit and the latest collections. */
export function directDebitsPage(opts: {
  user: { displayName: string; csrf: string };
  mandates: readonly DirectDebitMandateRow[];
  collections: readonly DirectDebitCollectionRow[];
}): string {
  const live = opts.mandates.filter((m) => m.active);
  const pending = live.filter((m) => m.mandateStatus !== 'active').length;
  const failed = opts.collections.filter((c) => c.status === 'failed' || c.status === 'rejected');
  const mandateRow = (dd: DirectDebitMandateRow) => {
    const last = dd.collections[0];
    return `<tr>
      <td><a class="row-link" href="/members/${dd.memberId}">${escapeHtml(dd.memberName)}</a></td>
      <td>${dd.selection ? escapeHtml(numbersLabel(dd.selection)) : '—'}</td>
      <td>${ddStatus(dd)}</td>
      <td>${escapeHtml(formatLondon(dd.createdAt))}</td>
      <td>${last ? `${escapeHtml(last.collectionDate)} · ${formatPence(pence(last.amountPence))} · ${escapeHtml(DD_COLLECTION_LABELS[last.status] ?? last.status)}` : '—'}</td>
    </tr>`;
  };
  return layout({
    title: 'Direct Debits',
    user: opts.user,
    body: `
      <h1>Direct Debits</h1>
      <div class="card">
        <p>${live.length} live Direct Debit${live.length === 1 ? '' : 's'}${pending > 0 ? `, ${pending} awaiting bank confirmation (not entered until confirmed)` : ''}.
        Collected monthly in advance on the 1st (or next working day): each member is told the amount 10&ndash;14 days before.
        A failed collection is tried once more a week later; a second failure stops the Direct Debit. A refund claim removes it.</p>
        <p class="muted">GAP-10: the bank route is still undecided, so collections go through whichever Bacs bureau is configured (the sandbox, on dev).</p>
      </div>
      ${
        failed.length > 0
          ? `<div class="card"><h2 style="font-size:1.05rem;margin-top:0">Failed or rejected collections</h2>
               <table><thead><tr><th>Member</th><th>Collection date</th><th>Amount</th><th>Draws</th><th>Result</th></tr></thead>
               <tbody>${failed.map((c) => ddCollectionRow(c, true)).join('')}</tbody></table></div>`
          : ''
      }
      <div class="card">
        <h2 style="font-size:1.05rem;margin-top:0">Mandates</h2>
        ${
          opts.mandates.length === 0
            ? '<p class="muted">No Direct Debits yet.</p>'
            : `<table><thead><tr><th>Member</th><th>Numbers</th><th>Status</th><th>Set up</th><th>Last collection</th></tr></thead>
                 <tbody>${opts.mandates.map(mandateRow).join('')}</tbody></table>`
        }
      </div>
      <div class="card">
        <h2 style="font-size:1.05rem;margin-top:0">Recent collections</h2>
        ${
          opts.collections.length === 0
            ? '<p class="muted">No collections yet. The first month&rsquo;s are prepared 14 days before its collection date.</p>'
            : `<table><thead><tr><th>Member</th><th>Collection date</th><th>Amount</th><th>Draws</th><th>Result</th></tr></thead>
                 <tbody>${opts.collections.map((c) => ddCollectionRow(c, true)).join('')}</tbody></table>`
        }
      </div>
    `,
  });
}

export function memberDetailPage(opts: {
  user: { displayName: string; csrf: string };
  member: MemberPage;
  error?: string;
  flash?: string;
}): string {
  const { profile, payments, upcoming } = opts.member;
  const details = [
    ['Name', memberName(profile)],
    ['Email', profile.email ?? '—'],
    ['Telephone', profile.telephone ?? '—'],
    ['Postal address', postalAddress(profile)],
    ['Preferred contact', CONTACT_LABELS[profile.preferredContact] ?? profile.preferredContact],
    ['Status', profile.status],
    ['Type', profile.memberType],
    ['Prize draw no.', profile.prizeDrawNumbers.length > 0 ? profile.prizeDrawNumbers.join(', ') : '—'],
    ['Added', formatLondon(profile.createdAt)],
  ]
    .map(([k, v]) => `<dt>${escapeHtml(k!)}</dt><dd>${escapeHtml(v!)}</dd>`)
    .join('');
  return layout({
    title: memberName(profile),
    user: opts.user,
    body: `
      <p><a class="muted" href="/members">← Back to members</a></p>
      <h1>${escapeHtml(memberName(profile))}</h1>
      <div class="card">
        ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
        ${opts.flash ? `<div class="flash">${escapeHtml(opts.flash)}</div>` : ''}
        <dl class="kv">${details}</dl>
        ${contactForm(opts.user.csrf, profile)}
      </div>
      <div class="card">
        <h2 style="font-size:1.05rem;margin-top:0">Numbers</h2>
        ${
          opts.member.lines.length === 0
            ? '<p class="muted">No numbers on any line.</p>'
            : `<table>
                 <thead><tr><th>Prize draw no.</th><th>Line</th><th>Numbers</th><th>Chosen by</th><th>Change to</th></tr></thead>
                 <tbody>${opts.member.lines.map((l) => lineRow(opts.user.csrf, profile.id, l)).join('\n')}</tbody>
               </table>
               <p class="muted">The line keeps its paid draws and any Direct Debit. Draws already closed to entries are drawn with the old numbers.</p>`
        }
      </div>
      <div class="card">
        <h2 style="font-size:1.05rem;margin-top:0">Direct Debit</h2>
        ${memberDirectDebits(opts.user.csrf, profile.id, opts.member.directDebits)}
      </div>
      <div class="card">
        <h2 style="font-size:1.05rem;margin-top:0">Payments</h2>
        ${
          payments.length === 0
            ? '<p class="muted">No payments recorded.</p>'
            : `<table>
                 <thead><tr><th>Date</th><th>Method</th><th>Amount</th><th>For numbers</th><th>Status</th><th>Reference</th></tr></thead>
                 <tbody>${payments.map(paymentRow).join('\n')}</tbody>
               </table>`
        }
      </div>
      <div class="card">
        <h2 style="font-size:1.05rem;margin-top:0">Upcoming draws entered</h2>
        ${
          upcoming.length === 0
            ? '<p class="muted">Not entered in any draw that has yet to be run.</p>'
            : `<table>
                 <thead><tr><th>Draw</th><th>Draw time</th><th>Status</th><th>Numbers</th><th>Paid by</th></tr></thead>
                 <tbody>${upcoming.map(upcomingRow).join('\n')}</tbody>
               </table>`
        }
      </div>
    `,
  });
}

function bankTransactionReviewField(txn: BankTransactionForReview): string {
  const rows = txn.candidates
    .map(
      (c) => `<label class="candidate-row" style="display:block;font-weight:normal">
        <input type="radio" name="acceptedPrizeDrawNo" value="${c.prizeDrawNo}" ${c.decision !== 'pending_review' ? 'disabled' : ''} />
        Prize draw no. ${c.prizeDrawNo} — ${escapeHtml(c.memberName ?? 'unlinked, no member')}
        (confidence ${c.confidence.toFixed(2)}${c.decision !== 'pending_review' ? `, already ${escapeHtml(c.decision)}` : ''})
      </label>`,
    )
    .join('\n');
  return `
    <div class="card" style="margin:0 0 1rem">
      <dl class="kv">
        <dt>Value date</dt><dd>${escapeHtml(txn.valueDate)}</dd>
        <dt>Description</dt><dd>${escapeHtml(txn.description ?? '—')}</dd>
        <dt>Amount</dt><dd>${formatPence(pence(BigInt(txn.amountPence)))}</dd>
        <dt>Reference</dt><dd>${escapeHtml(txn.extractedReference ?? '—')}</dd>
      </dl>
      <p class="muted">Pick the member this credit belongs to. Choosing one creates the payment
      (FR-5.8.3) when you resolve below; leaving none selected resolves the task without allocating
      anything — for a transaction genuinely nobody can identify.</p>
      ${rows || '<p class="muted">No candidates were found for this transaction.</p>'}
    </div>
  `;
}

export function taskDetailPage(opts: {
  user: { displayName: string; id: string; csrf: string };
  task: HumanTask;
  bankTransaction?: BankTransactionForReview;
  flash?: string;
  error?: string;
}): string {
  const { task } = opts;
  const meta = [
    ['Kind', task.kind],
    ['Status', task.status],
    ['Opened', task.openedAt.toISOString()],
    ['Due', task.dueAt ? task.dueAt.toISOString() : '—'],
    [
      'Escalated',
      task.escalationLevel > 0
        ? `${task.escalationLevel}× — last ${task.lastEscalatedAt?.toISOString() ?? '—'} (GAP-42: no escalation policy yet)`
        : '—',
    ],
    ['Gap', task.gapId ?? '—'],
    ['Workflow', task.workflowId ?? '—'],
    ['Run', task.runId ?? '—'],
    ['Signal / Update', task.signalName ?? task.updateName ?? '—'],
  ]
    .map(([k, v]) => `<dt>${escapeHtml(k!)}</dt><dd>${escapeHtml(v!)}</dd>`)
    .join('');

  let actionSection = '';
  if (task.status !== 'open') {
    actionSection = `<p class="flash">This task is already ${escapeHtml(task.status)}.</p>`;
  } else if (task.requiresSecondApprover && task.firstApproverId === opts.user.id) {
    actionSection = `<p class="muted">You gave the first approval on this task. It needs a <strong>different</strong> person to approve it a second time before it resolves.</p>`;
  } else {
    const approvalNote = task.requiresSecondApprover
      ? task.firstApproverId
        ? '<p class="muted">One approval recorded. This action will record the second, resolving the task (GAP-44: two distinct people).</p>'
        : '<p class="muted">This task requires two distinct approvers. This action records the first.</p>'
      : '';
    // GAP-24 is still undecided — the mechanism is collected from the human
    // making the decision, never defaulted by this code.
    const mechanismField =
      task.kind === 'must_be_won_decision'
        ? `<label for="mechanism">Must-be-won mechanism</label>
           <input type="text" id="mechanism" name="mechanism" required
                  placeholder="What mechanism does this decision use — not for the system to invent" />`
        : '';
    // FR-5.8.3: picking a candidate here is what actually creates the payment
    // (match-transactions.ts's acceptBankTransactionMatchTx) — resolving the
    // task alone does not. Leaving every radio unselected records the review
    // without allocating anything, for a transaction nobody can identify.
    const bankMatchField =
      task.kind === 'bank_transaction_review' && opts.bankTransaction
        ? bankTransactionReviewField(opts.bankTransaction)
        : '';
    actionSection = `
      ${approvalNote}
      <form method="post" action="/tasks/${task.id}/resolve">
        ${csrfField(opts.user.csrf)}
        ${mechanismField}
        ${bankMatchField}
        <label for="note">Resolution note</label>
        <textarea id="note" name="note" required placeholder="What was decided, and why"></textarea>
        <button type="submit">${task.requiresSecondApprover ? 'Record approval' : 'Resolve task'}</button>
      </form>
    `;
  }

  return layout({
    title: task.title,
    user: opts.user,
    body: `
      <p><a class="muted" href="/tasks">← Back to task inbox</a></p>
      <h1>${escapeHtml(task.title)}</h1>
      <div class="card">
        <p>${escapeHtml(task.detail)}</p>
        ${task.entityType === 'member' && task.entityId ? `<p><a href="/members/${escapeHtml(task.entityId)}">Open the member page →</a></p>` : ''}
        ${task.consequenceIfIgnored ? `<p class="muted"><strong>If nobody acts:</strong> ${escapeHtml(task.consequenceIfIgnored)}</p>` : ''}
        <dl class="kv">${meta}</dl>
      </div>
      <div class="card">
        ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
        ${opts.flash ? `<div class="flash">${escapeHtml(opts.flash)}</div>` : ''}
        ${actionSection}
      </div>
    `,
  });
}

function bankStatementRow(s: BankStatementSummary): string {
  return `<tr>
    <td><a class="row-link" href="/bank-statements/${s.id}">Statement ${s.statementNumber}</a></td>
    <td>${escapeHtml(s.periodStart)} – ${escapeHtml(s.periodEnd)}</td>
    <td><span class="badge">${escapeHtml(s.source)}</span></td>
    <td>${s.transactionCount}</td>
    <td>${s.matched}</td>
    <td>${s.ambiguous + s.unmatched > 0 ? `<strong>${s.ambiguous + s.unmatched}</strong>` : '0'}</td>
  </tr>`;
}

export function bankStatementsPage(opts: {
  user: { displayName: string; csrf: string };
  statements: BankStatementSummary[];
  error?: string;
  flash?: string;
}): string {
  const rows = opts.statements.map(bankStatementRow).join('\n');
  return layout({
    title: 'Bank statements',
    user: opts.user,
    body: `
      <h1>Bank statements</h1>
      <p class="muted">GAP-33: CSV upload — Open Banking is left for future consideration. Every credit
      becomes a review task until TG-04's auto-accept threshold is set (gap-register.md).</p>
      <div class="card">
        ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
        ${opts.flash ? `<div class="flash">${escapeHtml(opts.flash)}</div>` : ''}
        <h2 style="font-size:1.05rem;margin-top:0">Upload a statement</h2>
        <form method="post" action="/bank-statements">
          ${csrfField(opts.user.csrf)}
          <label for="file">CSV file (loads into the box below — nothing is uploaded until you click Ingest)</label>
          <input type="file" id="file" accept=".csv,text/csv" onchange="
            const f = this.files[0]; if (!f) return;
            f.text().then(t => { document.getElementById('csv').value = t; });
          " />
          <label for="csv">CSV content — the bank's own "TransactionHistory" export, or the canonical schema (docs/SETUP.md §2.2); the format is detected from the header</label>
          <textarea id="csv" name="csv" required placeholder="#statement 1 2026-08-01 2026-08-07 0 5000&#10;value_date,description,type,amount_pence,is_credit,reference"></textarea>
          <button type="submit">Ingest</button>
        </form>
      </div>
      <div class="card">
        ${
          opts.statements.length === 0
            ? '<p class="muted">No statements ingested yet.</p>'
            : `<table>
                 <thead><tr><th>Statement</th><th>Period</th><th>Source</th><th>Transactions</th><th>Matched</th><th>Needs review</th></tr></thead>
                 <tbody>${rows}</tbody>
               </table>`
        }
      </div>
    `,
  });
}

function bankTransactionRow(t: BankTransactionRow): string {
  const statusClass = t.matchStatus === 'matched' ? '' : 'overdue';
  return `<tr class="${statusClass}">
    <td>${escapeHtml(t.valueDate)}</td>
    <td>${escapeHtml(t.description ?? '—')}</td>
    <td>${formatPence(pence(BigInt(t.amountPence)))}</td>
    <td>${escapeHtml(t.extractedReference ?? '—')}</td>
    <td>${t.candidatePrizeDrawNos.length > 0 ? t.candidatePrizeDrawNos.join(', ') : '—'}</td>
    <td><span class="badge">${escapeHtml(t.matchStatus)}</span></td>
  </tr>`;
}

export function bankStatementDetailPage(opts: {
  user: { displayName: string; csrf: string };
  statement: BankStatementDetail;
}): string {
  const { statement } = opts;
  const rows = statement.transactions.map(bankTransactionRow).join('\n');
  return layout({
    title: `Statement ${statement.statementNumber}`,
    user: opts.user,
    body: `
      <p><a class="muted" href="/bank-statements">← Back to bank statements</a></p>
      <h1>Statement ${statement.statementNumber}</h1>
      <div class="card">
        <dl class="kv">
          <dt>Period</dt><dd>${escapeHtml(statement.periodStart)} – ${escapeHtml(statement.periodEnd)}</dd>
          <dt>Source</dt><dd>${escapeHtml(statement.source)}</dd>
          <dt>Ingested</dt><dd>${escapeHtml(statement.ingestedAt)}</dd>
          <dt>Matched</dt><dd>${statement.matched} of ${statement.transactionCount}</dd>
        </dl>
      </div>
      <div class="card">
        ${
          statement.transactions.length === 0
            ? '<p class="muted">No transactions.</p>'
            : `<table>
                 <thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Reference</th><th>Candidate prize draw no.</th><th>Status</th></tr></thead>
                 <tbody>${rows}</tbody>
               </table>
               <p class="muted">Ambiguous and unmatched transactions each opened a review task — see <a href="/tasks?status=open">Tasks</a>.</p>`
        }
      </div>
    `,
  });
}
