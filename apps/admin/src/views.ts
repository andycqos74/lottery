import type { DashboardCounts, HumanTask } from './db.js';

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
        <div class="stat"><span class="n">${counts.draws}</span><span class="l">Draws</span></div>
      </div>
      <div class="card">
        <p>The human task inbox (GAP-43) is the day-to-day surface of this console — every process that
        stopped to wait for a person shows up here rather than requiring anyone to touch the Temporal Web UI.</p>
        <a href="/tasks"><button type="button">Open task inbox →</button></a>
      </div>
    `,
  });
}

function taskRow(task: HumanTask): string {
  const overdue = task.dueAt !== null && task.dueAt.getTime() < Date.now();
  return `<tr class="${overdue ? 'overdue' : ''}">
    <td><a class="row-link" href="/tasks/${task.id}">${escapeHtml(task.title)}</a>${task.requiresSecondApprover ? ' <span class="badge">dual approval</span>' : ''}</td>
    <td><span class="badge">${escapeHtml(task.kind)}</span></td>
    <td>${task.openedAt.toISOString().slice(0, 10)}</td>
    <td>${task.dueAt ? task.dueAt.toISOString().slice(0, 10) : '—'}</td>
  </tr>`;
}

export function tasksPage(opts: { user: { displayName: string; csrf: string }; tasks: HumanTask[] }): string {
  const rows = opts.tasks.map(taskRow).join('\n');
  return layout({
    title: 'Task inbox',
    user: opts.user,
    body: `
      <h1>Open tasks</h1>
      <div class="card">
        ${
          opts.tasks.length === 0
            ? '<p class="muted">Nothing is waiting on a person right now.</p>'
            : `<table>
                 <thead><tr><th>Title</th><th>Kind</th><th>Opened</th><th>Due</th></tr></thead>
                 <tbody>${rows}</tbody>
               </table>`
        }
      </div>
    `,
  });
}

export function taskDetailPage(opts: {
  user: { displayName: string; id: string; csrf: string };
  task: HumanTask;
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
    actionSection = `
      ${approvalNote}
      <form method="post" action="/tasks/${task.id}/resolve">
        ${csrfField(opts.user.csrf)}
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
