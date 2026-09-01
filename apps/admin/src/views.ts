import { formatPence, pence } from '@qosfc/domain';
import type {
  BankStatementDetail,
  BankStatementSummary,
  BankTransactionForReview,
  BankTransactionRow,
  DashboardCounts,
  DrawSummary,
  HumanTask,
  MemberSummary,
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
  main { max-width: 760px; margin: 2rem auto; padding: 0 1.5rem; }
  .auth-shell main { max-width: 380px; margin-top: 4rem; }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; }
  .card { background: #fff; border: 1px solid #e2e5ea; border-radius: 8px; padding: 1.25rem 1.5rem;
          margin-bottom: 1.25rem; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; }
  .stat { text-align: center; }
  .stat .n { font-size: 1.8rem; font-weight: 700; display: block; }
  .stat .l { font-size: 0.8rem; color: #5b6472; }
  .stat.warn .n { color: #b3261e; }
  label { display: block; font-size: 0.85rem; font-weight: 600; margin: 0.75rem 0 0.25rem; }
  input[type=email], input[type=password], input[type=text], textarea {
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
           <a href="/bank-statements">Bank statements</a>
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
  const overdue = task.status === 'open' && task.dueAt !== null && task.dueAt.getTime() < Date.now();
  return `<tr class="${overdue ? 'overdue' : ''}">
    <td><a class="row-link" href="/tasks/${task.id}">${escapeHtml(task.title)}</a>${task.requiresSecondApprover ? ' <span class="badge">dual approval</span>' : ''}</td>
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

function drawRow(draw: DrawSummary): string {
  return `<tr>
    <td><a class="row-link" href="/draws/${draw.id}">Draw ${draw.drawNumber}</a></td>
    <td><span class="badge">${escapeHtml(draw.status)}</span></td>
    <td>${draw.drawDate.toISOString().slice(0, 10)}</td>
    <td>${draw.entriesCount ?? '—'}</td>
    <td>${draw.winningNumbers ? draw.winningNumbers.join(' · ') : '—'}</td>
    <td>${draw.jackpotPaidPence !== null ? formatPence(pence(draw.jackpotPaidPence)) : '—'}</td>
  </tr>`;
}

export function drawsPage(opts: { user: { displayName: string; csrf: string }; draws: DrawSummary[] }): string {
  const rows = opts.draws.map(drawRow).join('\n');
  return layout({
    title: 'Draws',
    user: opts.user,
    body: `
      <h1>Draws</h1>
      <p><a href="/draws/new"><button type="button">New draw</button></a></p>
      <div class="card">
        ${
          opts.draws.length === 0
            ? '<p class="muted">No draws yet.</p>'
            : `<table>
                 <thead><tr><th>Draw</th><th>Status</th><th>Date</th><th>Entries</th><th>Winning numbers</th><th>Paid</th></tr></thead>
                 <tbody>${rows}</tbody>
               </table>`
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
  members?: MemberSummary[];
  liveEntryCount?: number;
  error?: string;
  flash?: string;
}): string {
  const { draw } = opts;
  const entriesDisplay =
    opts.liveEntryCount !== undefined
      ? `${opts.liveEntryCount} (open)`
      : draw.entriesCount !== null
        ? String(draw.entriesCount)
        : '—';
  const meta = [
    ['Status', draw.status],
    ['Draw date', draw.drawDate.toISOString().slice(0, 10)],
    ['Entries', entriesDisplay],
    ['Winning numbers', draw.winningNumbers ? draw.winningNumbers.join(' · ') : '—'],
    ['Jackpot pre-draw', draw.jackpotPreDrawPence !== null ? formatPence(pence(draw.jackpotPreDrawPence)) : '—'],
    ['Winners', draw.winnersCount !== null ? String(draw.winnersCount) : '—'],
    ['Jackpot paid', draw.jackpotPaidPence !== null ? formatPence(pence(draw.jackpotPaidPence)) : '—'],
    ['Rollover out', draw.rolloverOutPence !== null ? formatPence(pence(draw.rolloverOutPence)) : '—'],
    ['Workflow', draw.workflowId ?? '—'],
    ['Drawn at', draw.drawnAt ? draw.drawnAt.toISOString() : '—'],
    ['Settled at', draw.settledAt ? draw.settledAt.toISOString() : '—'],
  ]
    .map(([k, v]) => `<dt>${escapeHtml(k!)}</dt><dd>${escapeHtml(v!)}</dd>`)
    .join('');

  let openSection = '';
  if (draw.status === 'open') {
    const members = opts.members ?? [];
    openSection = `
      <div class="card">
        ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
        ${opts.flash ? `<div class="flash">${escapeHtml(opts.flash)}</div>` : ''}
        <h2 style="font-size:1.05rem;margin-top:0">Add entry</h2>
        ${
          members.length === 0
            ? `<p class="muted">No members yet — <a href="/members">add one</a> first.</p>`
            : `<form method="post" action="/draws/${draw.id}/entries">
                 ${csrfField(opts.user.csrf)}
                 <label for="memberId">Member</label>
                 <select id="memberId" name="memberId" required>${members.map(memberOption).join('')}</select>
                 <label for="selection">Numbers (four, 1&ndash;20)</label>
                 <input type="text" id="selection" name="selection" required placeholder="2, 4, 5, 14" />
                 <button type="submit">Add entry</button>
               </form>`
        }
        ${
          members.length === 0
            ? ''
            : `<h2 style="font-size:1.05rem;margin-top:1.5rem">Record a physical/agent ticket</h2>
               <form method="post" action="/draws/${draw.id}/manual-tickets">
                 ${csrfField(opts.user.csrf)}
                 <label for="manualMemberId">Member</label>
                 <select id="manualMemberId" name="memberId" required>${members.map(memberOption).join('')}</select>
                 <label for="physicalTicketNumber">Physical ticket number</label>
                 <input type="text" id="physicalTicketNumber" name="physicalTicketNumber" required placeholder="e.g. 4471" />
                 <label for="purchaseDate">Purchase date</label>
                 <input type="date" id="purchaseDate" name="purchaseDate" required />
                 <label for="amountPounds">Amount paid (&pound;)</label>
                 <input type="number" id="amountPounds" name="amountPounds" required min="2" step="2" placeholder="2.00" />
                 <fieldset style="border:none;padding:0;margin:0.5rem 0">
                   <label><input type="radio" name="selectionMode" value="random" checked /> Pick random numbers</label>
                   <label><input type="radio" name="selectionMode" value="manual" /> Enter numbers from the ticket</label>
                   <input type="text" name="selection" placeholder="2, 4, 5, 14" />
                 </fieldset>
                 <button type="submit">Record ticket</button>
               </form>
               <p class="muted" style="margin:0.4rem 0 0">
                 Amount paid must be a whole multiple of &pound;2 — it buys that many prepaid blocks (GAP-17),
                 entered into this draw now and into each future open draw automatically, exactly like a
                 standing order.
               </p>`
        }
        <form method="post" action="/draws/${draw.id}/generate-entries" style="margin-top:1.25rem">
          ${csrfField(opts.user.csrf)}
          <button type="submit">Generate standing-order entries (GAP-17)</button>
        </form>
        <p class="muted" style="margin:0.4rem 0 0">
          Consumes one prepaid ticket block per member with an active persistent selection and an
          allocated standing-order/Giro/branch payment — do this before closing entries, or those
          members get nothing this draw.
        </p>
        <form method="post" action="/draws/${draw.id}/run" style="margin-top:1.25rem">
          ${csrfField(opts.user.csrf)}
          <button type="submit">Close entries &amp; run this draw →</button>
        </form>
      </div>
    `;
  }

  return layout({
    title: `Draw ${draw.drawNumber}`,
    user: opts.user,
    body: `
      <p><a class="muted" href="/draws">← Back to draws</a></p>
      <h1>Draw ${draw.drawNumber}</h1>
      <div class="card">
        <dl class="kv">${meta}</dl>
      </div>
      ${openSection}
    `,
  });
}

export function newDrawPage(opts: { user: { displayName: string; csrf: string }; error?: string }): string {
  return layout({
    title: 'New draw',
    user: opts.user,
    body: `
      <p><a class="muted" href="/draws">← Back to draws</a></p>
      <h1>New draw</h1>
      <div class="card">
        ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
        <form method="post" action="/draws">
          ${csrfField(opts.user.csrf)}
          <label for="drawNumber">Draw number</label>
          <input type="number" id="drawNumber" name="drawNumber" required min="1" />
          <button type="submit">Create draw</button>
        </form>
        <p class="muted">Draw date is set to today. Add entries once the draw is created; nothing is drawn until you close it.</p>
      </div>
    `,
  });
}

function memberRow(m: MemberSummary): string {
  const label = `${m.forename ?? ''} ${m.surname ?? ''}`.trim() || '—';
  return `<tr>
    <td>${escapeHtml(label)}</td>
    <td><span class="badge">${escapeHtml(m.status)}</span></td>
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
          <button type="submit">Add member</button>
        </form>
      </div>
      <div class="card">
        ${
          opts.members.length === 0
            ? '<p class="muted">No members yet.</p>'
            : `<table>
                 <thead><tr><th>Name</th><th>Status</th><th>Entries</th></tr></thead>
                 <tbody>${rows}</tbody>
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
