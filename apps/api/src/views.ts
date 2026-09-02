import { formatPence, pence } from '@qosfc/domain';
import type { MemberDetails, MyEntry, OpenDraw, SettledDraw } from './db.js';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  :root { color-scheme: light; --royal:#122a5c; --royal-deep:#0c1d40; --gold:#c9a227; --paper:#f6f5f0; --ink:#1a1d23; --line:#dfe0e6; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0;
         background: var(--paper); color: var(--ink); }
  header { background: var(--royal-deep); color: #fff; padding: 0.9rem 1.5rem; display: flex;
           align-items: center; justify-content: space-between; }
  header a.brand { color: #fff; text-decoration: none; font-weight: 700; letter-spacing: 0.01em; }
  header nav a { margin-left: 1.25rem; color: #c7d2e6; text-decoration: none; font-weight: 500; font-size: 0.9rem; }
  header nav a:hover, header nav a.active { color: #fff; }
  main { max-width: 760px; margin: 2rem auto; padding: 0 1.5rem; }
  .auth-shell main { max-width: 380px; margin-top: 4rem; }
  h1 { font-size: 1.5rem; margin: 0 0 1rem; }
  h2 { font-size: 1.05rem; margin: 1.5rem 0 0.75rem; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 1.25rem 1.5rem;
          margin-bottom: 1.25rem; }
  label { display: block; font-size: 0.85rem; font-weight: 600; margin: 0.75rem 0 0.25rem; }
  input[type=email], input[type=password], input[type=text], input[type=tel], select {
    width: 100%; padding: 0.55rem 0.65rem; border: 1px solid #cbd1db; border-radius: 6px; font-size: 0.95rem;
  }
  button { margin-top: 1.1rem; background: var(--royal); color: #fff; border: none; border-radius: 6px;
           padding: 0.65rem 1.2rem; font-size: 0.95rem; cursor: pointer; }
  button:hover { background: #1c3a78; }
  button.gold { background: var(--gold); color: #2b2205; font-weight: 700; }
  button.gold:hover { background: #dab335; }
  button.secondary { background: #fff; color: var(--royal); border: 1px solid #cbd1db; }
  .error { background: #fdecea; color: #b3261e; border: 1px solid #f3c1bd; border-radius: 6px;
           padding: 0.6rem 0.8rem; margin-bottom: 0.75rem; font-size: 0.9rem; }
  .flash { background: #eaf6ec; color: #1e6b34; border: 1px solid #bfe3c6; border-radius: 6px;
           padding: 0.6rem 0.8rem; margin-bottom: 0.75rem; font-size: 0.9rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.55rem 0.5rem; border-bottom: 1px solid #eef0f3; }
  th { color: #5b6472; font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; }
  .muted { color: #5b6472; font-size: 0.88rem; }
  .balls { display: flex; gap: 0.35rem; flex-wrap: wrap; }
  .ball { width: 2.1rem; height: 2.1rem; border-radius: 999px; display: inline-flex; align-items: center;
          justify-content: center; font-weight: 700; font-size: 0.9rem; background: #eef0f3; color: var(--royal); }
  .ball.win { background: var(--gold); color: #2b2205; }
  .pick-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 0.5rem; max-width: 320px; margin: 0.5rem 0 0.25rem; }
  .pick-grid label { margin: 0; }
  .pick-grid input { position: absolute; opacity: 0; }
  .pick-grid span { display: flex; align-items: center; justify-content: center; height: 2.4rem; border-radius: 8px;
                     border: 1px solid #cbd1db; font-weight: 700; cursor: pointer; user-select: none; }
  .pick-grid input:checked + span { background: var(--royal); color: #fff; border-color: var(--royal); }
  .pill { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 999px; font-size: 0.78rem; font-weight: 600; }
  .pill-win { background: #eaf6ec; color: #1e6b34; }
  .pill-roll { background: #fdf3e3; color: #8a5a00; }
  .stake { font-family: ui-monospace, "SF Mono", monospace; }
  dl.kv { display: grid; grid-template-columns: 9rem 1fr; row-gap: 0.4rem; font-size: 0.9rem; }
  dl.kv dt { color: #5b6472; }
  dl.kv dd { margin: 0; }
`;

function csrfField(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />`;
}

export interface ViewMember {
  readonly forename: string | null;
  readonly csrf: string;
}

function layout(opts: { title: string; body: string; member?: ViewMember | undefined; active?: string; authShell?: boolean }): string {
  const nav = opts.member
    ? `<header>
         <a class="brand" href="/draw">QOSFC Lottery</a>
         <nav>
           <a href="/draw" ${opts.active === 'draw' ? 'class="active"' : ''}>Current draw</a>
           <a href="/account" ${opts.active === 'account' ? 'class="active"' : ''}>My account</a>
           <a href="/past-draws" ${opts.active === 'past' ? 'class="active"' : ''}>Past draws</a>
           <span class="muted" style="color:#c7d2e6;margin-left:1.25rem">${escapeHtml(opts.member.forename ?? 'Member')}</span>
           <form method="post" action="/logout" style="display:inline">
             ${csrfField(opts.member.csrf)}
             <button type="submit" class="secondary" style="margin:0 0 0 0.6rem;padding:0.25rem 0.7rem;font-size:0.85rem">Log out</button>
           </form>
         </nav>
       </header>`
    : `<header>
         <a class="brand" href="/past-draws">QOSFC Lottery</a>
         <nav>
           <a href="/past-draws" ${opts.active === 'past' ? 'class="active"' : ''}>Past draws</a>
           <a href="/login" ${opts.active === 'login' ? 'class="active"' : ''}>Log in</a>
           <a href="/register" ${opts.active === 'register' ? 'class="active"' : ''}>Sign up</a>
         </nav>
       </header>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(opts.title)} — QOSFC Lottery</title>
  <style>${STYLE}</style>
</head>
<body class="${opts.authShell ? 'auth-shell' : ''}">
  ${nav}
  <main>${opts.body}</main>
</body>
</html>`;
}

export function registerPage(opts: { error?: string }): string {
  return layout({
    title: 'Sign up',
    authShell: true,
    active: 'register',
    body: `
      <h1>Join the lottery</h1>
      <div class="card">
        ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
        <form method="post" action="/register">
          <label for="forename">Forename</label>
          <input type="text" id="forename" name="forename" required autofocus />
          <label for="surname">Surname</label>
          <input type="text" id="surname" name="surname" required />
          <label for="email">Email</label>
          <input type="email" id="email" name="email" required autocomplete="username" />
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required minlength="10" autocomplete="new-password" />
          <p class="muted" style="margin:0.2rem 0 0">At least 10 characters.</p>
          <button type="submit">Create account</button>
        </form>
      </div>
      <p class="muted">Already a member? <a href="/login">Log in</a>.</p>
    `,
  });
}

export function loginPage(opts: { error?: string }): string {
  return layout({
    title: 'Log in',
    authShell: true,
    active: 'login',
    body: `
      <h1>Log in</h1>
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
      <p class="muted">New here? <a href="/register">Sign up</a>.</p>
    `,
  });
}

function pickGrid(selected: number[] = []): string {
  const cells = Array.from({ length: 20 }, (_, i) => i + 1)
    .map(
      (n) =>
        `<label><input type="checkbox" name="selection" value="${n}" ${selected.includes(n) ? 'checked' : ''} /><span>${n}</span></label>`,
    )
    .join('');
  return `<div class="pick-grid">${cells}</div>`;
}

export function drawPage(opts: { member: ViewMember; draw?: OpenDraw; error?: string }): string {
  const { draw } = opts;
  const body = draw
    ? `
      <h1>Draw No. ${draw.drawNumber}</h1>
      <p class="muted">Draw date ${escapeHtml(draw.drawDate)}. Entry costs ${formatPence(pence(200n))} and pays into the club's jackpot.</p>
      <div class="card">
        ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
        <form method="post" action="/draw/enter">
          ${csrfField(opts.member.csrf)}
          <label>Pick four numbers from 1&ndash;20</label>
          ${pickGrid()}
          <button type="submit" class="gold">Pay ${formatPence(pence(200n))} &amp; enter →</button>
        </form>
        <p class="muted" style="margin-top:0.75rem">
          Payment runs through QOSFC's sandbox payment gateway while a real card acquirer is being set up (GAP-09) —
          any card details work in the sandbox; nothing is really charged.
        </p>
      </div>
    `
    : `
      <h1>Current draw</h1>
      <div class="card"><p class="muted">No draw is open for entries right now — check back soon.</p></div>
    `;
  return layout({ title: 'Current draw', member: opts.member, active: 'draw', body });
}

export function purchaseReturnPage(opts: {
  member: ViewMember;
  status: 'paid' | 'pending' | 'failed' | 'not_found';
  reason?: string;
}): string {
  const body =
    opts.status === 'paid'
      ? `<h1>You're in!</h1><div class="flash">Payment received — your entry is confirmed for this draw.</div>
         <p><a href="/account"><button type="button">View my numbers</button></a></p>`
      : opts.status === 'pending'
        ? `<h1>Payment processing</h1><p class="muted">This can take a moment. Refresh this page shortly, or check "My account" later.</p>`
        : opts.status === 'failed'
          ? `<h1>Payment did not go through</h1><div class="error">${escapeHtml(opts.reason ?? 'The payment was not successful.')}</div>
             <p><a href="/draw"><button type="button">Try again</button></a></p>`
          : `<h1>Unknown payment session</h1><p class="muted">We couldn't find that payment attempt.</p>`;
  return layout({ title: 'Payment', member: opts.member, active: 'draw', body });
}

function entryRow(e: MyEntry): string {
  const balls = e.selection
    .map((n) => `<span class="ball ${e.winningNumbers?.includes(n) ? 'win' : ''}">${n}</span>`)
    .join('');
  const won = e.drawStatus === 'settled' && e.winningNumbers && e.selection.every((n) => e.winningNumbers!.includes(n));
  return `<tr>
    <td>Draw ${e.drawNumber}<br/><span class="muted">${escapeHtml(e.drawDate)}</span></td>
    <td><div class="balls">${balls}</div></td>
    <td><span class="pill ${won ? 'pill-win' : ''}">${escapeHtml(e.drawStatus)}${won ? ' · winner' : ''}</span></td>
  </tr>`;
}

export function accountPage(opts: { member: ViewMember; details: MemberDetails; entries: MyEntry[]; error?: string; flash?: string }): string {
  const { details, entries } = opts;
  const rows = entries.map(entryRow).join('\n');
  const contactOption = (value: string, label: string) =>
    `<option value="${value}" ${details.preferredContact === value ? 'selected' : ''}>${label}</option>`;
  return layout({
    title: 'My account',
    member: opts.member,
    active: 'account',
    body: `
      <h1>My account</h1>
      ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
      ${opts.flash ? `<div class="flash">${escapeHtml(opts.flash)}</div>` : ''}

      <h2>My numbers</h2>
      <div class="card">
        ${
          entries.length === 0
            ? `<p class="muted">No entries yet — <a href="/draw">enter the current draw</a>.</p>`
            : `<table><thead><tr><th>Draw</th><th>Numbers</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>`
        }
      </div>

      <h2>My details</h2>
      <div class="card">
        <dl class="kv">
          <dt>Name</dt><dd>${escapeHtml(`${details.forename ?? ''} ${details.surname ?? ''}`.trim())}</dd>
          <dt>Email</dt><dd>${escapeHtml(details.email ?? '—')}</dd>
        </dl>
        <form method="post" action="/account/details" style="margin-top:1rem">
          ${csrfField(opts.member.csrf)}
          <label for="telephone">Telephone</label>
          <input type="tel" id="telephone" name="telephone" value="${escapeHtml(details.telephone ?? '')}" />
          <label for="address1">Address line 1</label>
          <input type="text" id="address1" name="address1" value="${escapeHtml(details.address1 ?? '')}" />
          <label for="address2">Address line 2</label>
          <input type="text" id="address2" name="address2" value="${escapeHtml(details.address2 ?? '')}" />
          <label for="address3">Town</label>
          <input type="text" id="address3" name="address3" value="${escapeHtml(details.address3 ?? '')}" />
          <label for="postCode">Postcode</label>
          <input type="text" id="postCode" name="postCode" value="${escapeHtml(details.postCode ?? '')}" />
          <label for="preferredContact">Preferred contact method</label>
          <select id="preferredContact" name="preferredContact">
            ${contactOption('email', 'Email')}
            ${contactOption('post', 'Post')}
            ${contactOption('phone', 'Phone')}
          </select>
          <button type="submit">Save details</button>
        </form>
      </div>
    `,
  });
}

function pastDrawRow(d: SettledDraw): string {
  const balls = d.winningNumbers.map((n) => `<span class="ball win">${n}</span>`).join('');
  const rolled = d.rolloverOutPence !== null && BigInt(d.rolloverOutPence) > 0n;
  return `<tr>
    <td>Draw ${d.drawNumber}<br/><span class="muted">${escapeHtml(d.drawDate)}</span></td>
    <td><div class="balls">${balls}</div></td>
    <td>${d.jackpotPaidPence !== null ? formatPence(pence(BigInt(d.jackpotPaidPence))) : '—'}</td>
    <td>${d.winnersCount ?? 0}
      ${rolled ? `<span class="pill pill-roll" style="margin-left:0.4rem">rolled over</span>` : ''}
    </td>
  </tr>`;
}

export function pastDrawsPage(opts: { member?: ViewMember; draws: SettledDraw[] }): string {
  const rows = opts.draws.map(pastDrawRow).join('\n');
  return layout({
    title: 'Past draws',
    member: opts.member,
    active: 'past',
    body: `
      <h1>Past draws</h1>
      <div class="card">
        ${
          opts.draws.length === 0
            ? '<p class="muted">No draws have been settled yet.</p>'
            : `<table><thead><tr><th>Draw</th><th>Winning numbers</th><th>Jackpot paid</th><th>Winners</th></tr></thead><tbody>${rows}</tbody></table>`
        }
      </div>
    `,
  });
}
