import { formatPence, pence } from '@qosfc/domain';
import type { DrawStats, MemberDetails, MyEntry, OpenDraw, SettledDraw } from './db.js';
import { MAX_LINES_PER_PURCHASE, PURCHASE_BLOCK_SIZES } from './entries.js';
import type { DirectDebitStatus } from './direct-debit.js';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  :root{
    --ink:#17213c; --ink-soft:#4a5270; --paper:#f6f2e7; --surface:#ffffff; --surface-sunk:#efe9db;
    --line:#ddd4bd; --royal:#1e3f8f; --royal-deep:#12275e; --royal-soft:#e7ecf8;
    --gold:#a9761f; --gold-bright:#c98d24; --gold-soft:#f4e6c8; --good:#2f6d4e; --good-soft:#e2f0e6;
    --focus:#c98d24; --shadow: 0 1px 2px rgba(23,33,60,.06), 0 8px 24px -12px rgba(23,33,60,.18);
  }
  @media (prefers-color-scheme: dark){
    :root:not([data-theme="light"]){
      --ink:#eee8d9; --ink-soft:#b7b3ac; --paper:#0e1730; --surface:#141f3f; --surface-sunk:#0a1226;
      --line:#2a3660; --royal:#7695e6; --royal-deep:#a9c0f2; --royal-soft:#1b2a54;
      --gold:#e0b158; --gold-bright:#f0c774; --gold-soft:#2c2413; --good:#7bcc9e; --good-soft:#12271c;
      --focus:#e0b158; --shadow: 0 1px 2px rgba(0,0,0,.4), 0 12px 28px -14px rgba(0,0,0,.6);
    }
  }
  :root[data-theme="dark"]{
    --ink:#eee8d9; --ink-soft:#b7b3ac; --paper:#0e1730; --surface:#141f3f; --surface-sunk:#0a1226;
    --line:#2a3660; --royal:#7695e6; --royal-deep:#a9c0f2; --royal-soft:#1b2a54;
    --gold:#e0b158; --gold-bright:#f0c774; --gold-soft:#2c2413; --good:#7bcc9e; --good-soft:#12271c;
    --focus:#e0b158; --shadow: 0 1px 2px rgba(0,0,0,.4), 0 12px 28px -14px rgba(0,0,0,.6);
  }
  *{box-sizing:border-box}
  body{ margin:0; background:var(--paper); color:var(--ink); font-family:'Figtree', system-ui, sans-serif; -webkit-font-smoothing:antialiased; }
  h1,h2,h3,.display{ font-family:'Big Shoulders Display', 'Arial Narrow', sans-serif; text-transform:uppercase; letter-spacing:.02em; margin:0; color:var(--ink); }
  .num, .tabular{ font-family:'Space Mono', ui-monospace, monospace; font-variant-numeric:tabular-nums; }
  a{ color:var(--royal) }
  :where(a,button,input,select):focus-visible{ outline:2px solid var(--focus); outline-offset:2px; border-radius:4px; }

  .app{ display:grid; grid-template-columns:250px 1fr; min-height:100vh; }
  .side{ background:var(--royal-deep); color:#eef1fa; padding:1.5rem 1.1rem; display:flex; flex-direction:column; gap:1.6rem; }
  .brand{ line-height:1; }
  .brand .club{ font-size:.72rem; letter-spacing:.16em; color:var(--gold-bright); font-weight:600; display:block; margin-bottom:.35rem; }
  .brand .name{ font-size:1.9rem; font-weight:800; color:#fff; line-height:.95; text-decoration:none; display:block; }
  .brand .sub{ display:block; margin-top:.4rem; font-size:.78rem; color:#b9c3e6; font-family:'Figtree',sans-serif; text-transform:none; letter-spacing:0; }

  nav.pages{ display:flex; flex-direction:column; gap:.15rem; }
  nav.pages a{ display:flex; align-items:baseline; gap:.6rem; padding:.55rem .6rem; border-radius:8px; font-size:.93rem; font-weight:600;
               color:#c7cfe8; text-decoration:none; transition:background .15s, color .15s; }
  nav.pages a .idx{ font-family:'Space Mono',monospace; font-size:.72rem; color:#7488c0; width:1.1rem; }
  nav.pages a:hover{ background:rgba(255,255,255,.06); color:#fff; }
  nav.pages a.active{ background:#fff; color:var(--royal-deep); }
  nav.pages a.active .idx{ color:var(--gold); }
  nav.pages form{ margin-top:.5rem; }
  nav.pages form button{ all:unset; cursor:pointer; display:block; padding:.55rem .6rem; border-radius:8px; font-size:.93rem; font-weight:600; color:#c7cfe8; width:100%; }
  nav.pages form button:hover{ background:rgba(255,255,255,.06); color:#fff; }

  .countdown{ margin-top:auto; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.12); border-radius:10px; padding:.85rem .9rem; }
  .countdown .lbl{ font-size:.68rem; letter-spacing:.12em; color:#9fadd6; text-transform:uppercase; }
  .countdown .val{ font-family:'Space Mono',monospace; font-size:1.05rem; color:#fff; margin-top:.25rem; }
  .countdown .val b{ color:var(--gold-bright); }

  main{ padding:1.6rem 2.4rem 4rem; max-width:920px; }
  .page-head{ margin-bottom:1.6rem; }
  .page-head h1{ font-size:2.5rem; }
  .page-head p{ color:var(--ink-soft); margin:.4rem 0 0; max-width:60ch; font-size:1rem; }

  .card{ background:var(--surface); border:1px solid var(--line); border-radius:14px; box-shadow:var(--shadow); padding:1.4rem 1.5rem; }
  .stack{ display:flex; flex-direction:column; gap:1.1rem; }
  .grid2{ display:grid; grid-template-columns:1fr 1fr; gap:1.1rem; }
  .row2{ display:grid; grid-template-columns:1fr 1fr; gap:.9rem; }

  label{ font-size:.82rem; font-weight:600; color:var(--ink-soft); display:block; margin-bottom:.3rem; }
  input[type=text],input[type=email],input[type=password],input[type=tel],select{
    width:100%; font:inherit; font-family:'Figtree',sans-serif; padding:.6rem .7rem; border-radius:8px;
    border:1px solid var(--line); background:var(--surface); color:var(--ink);
  }
  .field{ margin-bottom:0; }
  .hint{ font-size:.78rem; color:var(--ink-soft); margin-top:.35rem; }

  .btn{ all:unset; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; gap:.4rem; font-weight:700; font-size:.92rem;
        padding:.65rem 1.2rem; border-radius:9px; font-family:'Figtree',sans-serif; }
  .btn-primary{ background:var(--royal); color:#fff; }
  .btn-primary:hover{ background:var(--royal-deep); }
  .btn-gold{ background:var(--gold-bright); color:#2a1c02; }
  .btn-gold:hover{ filter:brightness(.94); }
  .btn-ghost{ background:transparent; color:var(--royal); border:1px solid var(--line); }
  .btn-ghost:hover{ background:var(--royal-soft); }
  .btn-block{ width:100%; }
  .linkbtn{ all:unset; cursor:pointer; color:var(--royal); font-weight:600; }
  .linkbtn:hover{ text-decoration:underline; }

  .divider{ border:none; border-top:1px solid var(--line); margin:0; }

  .ball-row{ display:flex; flex-wrap:wrap; gap:.5rem; }
  .ball{ width:2.5rem; height:2.5rem; border-radius:50%; display:flex; align-items:center; justify-content:center;
         font-family:'Space Mono',monospace; font-weight:700; font-size:.95rem; border:1.5px solid var(--line);
         background:var(--surface); color:var(--ink); }
  .ball.picked{ background:var(--royal); border-color:var(--royal); color:#fff; }
  .ball.win{ background:var(--gold-bright); border-color:var(--gold-bright); color:#2a1c02; }
  .ball-grid{ display:grid; grid-template-columns:repeat(10,2.5rem); gap:.5rem; }
  .ball-grid label{ margin:0; cursor:pointer; }
  .ball-grid input{ position:absolute; opacity:0; width:2.5rem; height:2.5rem; cursor:pointer; }
  .ball-grid .ball{ pointer-events:none; }
  .ball-grid input:checked + .ball{ background:var(--royal); border-color:var(--royal); color:#fff; }

  .pill{ display:inline-flex; align-items:center; gap:.35rem; font-size:.74rem; font-weight:700; letter-spacing:.03em; padding:.22rem .55rem; border-radius:999px; }
  .pill-open{ background:var(--good-soft); color:var(--good); }
  .pill-rollover{ background:var(--gold-soft); color:var(--gold); }
  .pill-win{ background:var(--gold-bright); color:#2a1c02; }

  table{ width:100%; border-collapse:collapse; }
  th{ text-align:left; font-size:.72rem; letter-spacing:.08em; text-transform:uppercase; color:var(--ink-soft); padding:.5rem .6rem; border-bottom:1px solid var(--line); }
  td{ padding:.65rem .6rem; border-bottom:1px solid var(--line); font-size:.9rem; vertical-align:middle; }
  tr:last-child td{ border-bottom:none; }
  .amt{ font-family:'Space Mono',monospace; font-weight:700; }

  .stat{ display:flex; flex-direction:column; gap:.15rem; }
  .stat .k{ font-size:.72rem; text-transform:uppercase; letter-spacing:.08em; color:var(--ink-soft); }
  .stat .v{ font-family:'Big Shoulders Display',sans-serif; font-size:1.9rem; font-weight:800; }
  .stat .v small{ font-size:1rem; font-weight:600; font-family:'Figtree',sans-serif; text-transform:none; color:var(--ink-soft); }

  .banner{ background:var(--royal-soft); border:1px solid var(--royal); border-radius:10px; padding:.75rem 1rem; font-size:.86rem;
           color:var(--royal-deep); display:flex; gap:.6rem; align-items:flex-start; }
  .error{ background:#fdecea; color:#b3261e; border:1px solid #f3c1bd; border-radius:10px; padding:.75rem 1rem; font-size:.9rem; }
  .flash{ background:var(--good-soft); color:var(--good); border:1px solid var(--good); border-radius:10px; padding:.75rem 1rem; font-size:.9rem; }

  .method-choices{ display:grid; grid-template-columns:1fr 1fr; gap:.6rem; }
  .method-choice{ display:flex; gap:.6rem; align-items:flex-start; padding:.75rem .8rem; border:1px solid var(--line); border-radius:10px; cursor:pointer; background:var(--surface); }
  .method-choice b{ display:block; font-size:.92rem; }
  .method-choice .hint{ display:block; margin-top:.15rem; }
  .method-choice:has(input:checked){ border-color:var(--royal); background:var(--royal-soft); }
  @media (max-width: 640px){ .method-choices{ grid-template-columns:1fr; } }
  [hidden]{ display:none !important; }

  .muted{ color:var(--ink-soft); }
  .sep-label{ font-size:.72rem; text-transform:uppercase; letter-spacing:.1em; color:var(--ink-soft); margin:1.6rem 0 .7rem; }
  .toggle-note{ display:flex; align-items:flex-start; gap:.5rem; font-size:.85rem; }
  .toggle-note input{ margin-top:.2rem; }

  fieldset{ border:1px solid var(--line); border-radius:10px; padding:.8rem .9rem; margin:0; }
  fieldset legend{ font-size:.82rem; font-weight:600; color:var(--ink-soft); padding:0 .3rem; }
  .radio-row{ display:flex; align-items:center; gap:.5rem; padding:.35rem 0; font-size:.9rem; cursor:pointer; }
  .radio-row .amt{ margin-left:auto; }

  @media (max-width:860px){
    .app{ grid-template-columns:1fr; }
    .side{ flex-direction:row; align-items:center; overflow-x:auto; padding:1rem; }
    nav.pages{ flex-direction:row; }
    .countdown{ display:none; }
    main{ padding:1.2rem 1.2rem 3rem; }
    .grid2,.row2{ grid-template-columns:1fr; }
    .ball-grid{ grid-template-columns:repeat(5,2.5rem); }
  }
`;

const LONDON_DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** All draw times are UK times, whatever timezone the server runs in. */
function formatLondon(value: Date): string {
  return LONDON_DATE_TIME.format(value);
}

function drawWhen(draw: OpenDraw): string {
  return draw.drawAt ? formatLondon(draw.drawAt) : draw.drawDate;
}

function drawHeading(draw: OpenDraw): string {
  return draw.name ? `${draw.name} — Draw No. ${draw.drawNumber}` : `Draw No. ${draw.drawNumber}`;
}

function csrfField(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />`;
}

export interface ViewMember {
  readonly forename: string | null;
  readonly csrf: string;
}

interface NavItem {
  readonly idx: string;
  readonly label: string;
  readonly href: string;
  readonly id: string;
}

const LOGGED_IN_NAV: NavItem[] = [
  { idx: '01', label: 'Current draw', href: '/draw', id: 'draw' },
  { idx: '02', label: 'My numbers', href: '/account', id: 'account' },
  { idx: '03', label: 'My details', href: '/details', id: 'details' },
  { idx: '04', label: 'Past draws', href: '/past-draws', id: 'past' },
];

const LOGGED_OUT_NAV: NavItem[] = [
  { idx: '01', label: 'Sign up', href: '/register', id: 'register' },
  { idx: '02', label: 'Log in', href: '/login', id: 'login' },
  { idx: '03', label: 'Past draws', href: '/past-draws', id: 'past' },
];

function layout(opts: {
  title: string;
  body: string;
  member?: ViewMember | undefined;
  active: string;
  openDraw?: OpenDraw | undefined;
}): string {
  const items = opts.member ? LOGGED_IN_NAV : LOGGED_OUT_NAV;
  const navHtml = items
    .map(
      (item) =>
        `<a href="${item.href}" class="${item.id === opts.active ? 'active' : ''}"><span class="idx">${item.idx}</span>${escapeHtml(item.label)}</a>`,
    )
    .join('');
  const logout = opts.member
    ? `<form method="post" action="/logout">${csrfField(opts.member.csrf)}<button type="submit">Log out</button></form>`
    : '';
  const countdown = opts.openDraw
    ? `<div class="countdown"><span class="lbl">Draw No. ${opts.openDraw.drawNumber}</span><div class="val">${escapeHtml(drawWhen(opts.openDraw))}</div>${
        opts.openDraw.entriesCloseAt
          ? `<div class="lbl" style="margin-top:.45rem">Entries close</div><div class="val" style="font-size:.9rem">${escapeHtml(formatLondon(opts.openDraw.entriesCloseAt))}</div>`
          : ''
      }</div>`
    : `<div class="countdown"><span class="lbl">Next draw</span><div class="val">None open right now</div></div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(opts.title)} — The Doonhamers Draw</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;700;800;900&family=Figtree:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap">
  <style>${STYLE}</style>
</head>
<body>
  <div class="app">
    <aside class="side">
      <div class="brand">
        <span class="club">Queen of the South F.C.</span>
        <a class="name" href="${opts.member ? '/draw' : '/past-draws'}">The Doonhamers<br>Draw</a>
        <span class="sub">Numbers portal — Palmerston Park</span>
      </div>
      <nav class="pages" aria-label="Portal pages">
        ${navHtml}
        ${logout}
      </nav>
      ${countdown}
    </aside>
    <main>${opts.body}</main>
  </div>
</body>
</html>`;
}

export function registerPage(opts: { error?: string; openDraw?: OpenDraw | undefined }): string {
  return layout({
    title: 'Sign up',
    active: 'register',
    ...(opts.openDraw ? { openDraw: opts.openDraw } : {}),
    body: `
      <div class="page-head">
        <h1>Join the draw</h1>
        <p>Pick 4 numbers from 1&ndash;20, every week, for £2. Every entry supports Queen of the South FC &mdash; match all four and share the jackpot.</p>
      </div>
      <div class="grid2">
        <div class="card stack">
          ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
          <form method="post" action="/register" class="stack">
            <div class="row2">
              <div class="field"><label for="forename">Forename</label><input id="forename" name="forename" type="text" required autofocus /></div>
              <div class="field"><label for="surname">Surname</label><input id="surname" name="surname" type="text" required /></div>
            </div>
            <div class="field"><label for="email">Email address</label><input id="email" name="email" type="email" required autocomplete="username" /></div>
            <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" required minlength="10" autocomplete="new-password" />
              <p class="hint">At least 10 characters.</p></div>
            <button class="btn btn-primary btn-block" type="submit">Create my account</button>
          </form>
          <p class="hint" style="text-align:center">Already a member? <a href="/login">Log in</a></p>
        </div>
        <div class="stack">
          <div class="card stack">
            <h3 style="font-size:1.1rem;text-transform:none;letter-spacing:0">Why join the Draw</h3>
            <div class="stack" style="gap:.6rem">
              <div class="banner"><span>🏟️</span><span><b>100% of profit</b> goes to first-team and youth academy funding at Palmerston Park.</span></div>
              <div class="banner"><span>🎟️</span><span>Entries are £2 each. Pay per draw, or in blocks of 4 or 12 to skip the top-up.</span></div>
              <div class="banner"><span>🏆</span><span>Match all <b>4 of 4</b> numbers to share that week's jackpot. No match, no worries &mdash; it rolls into next week's.</span></div>
            </div>
          </div>
        </div>
      </div>
    `,
  });
}

export function loginPage(opts: { error?: string; notice?: string; openDraw?: OpenDraw | undefined }): string {
  return layout({
    title: 'Log in',
    active: 'login',
    ...(opts.openDraw ? { openDraw: opts.openDraw } : {}),
    body: `
      <div class="page-head">
        <h1>Welcome back</h1>
        <p>Log in to check this week's numbers, top up your entries, or see what you've won.</p>
      </div>
      <div class="card stack" style="max-width:420px">
        ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
        ${opts.notice ? `<div class="banner"><span>✅</span><span>${escapeHtml(opts.notice)}</span></div>` : ''}
        <form method="post" action="/login" class="stack">
          <div class="field"><label for="email">Email address</label><input id="email" name="email" type="email" required autofocus autocomplete="username" /></div>
          <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password" /></div>
          <button class="btn btn-primary btn-block" type="submit">Log in</button>
        </form>
        <p class="hint" style="text-align:center"><a href="/forgot-password">Forgotten your password?</a></p>
        <hr class="divider">
        <p class="hint" style="text-align:center">New to the Draw? <a href="/register">Create an account</a></p>
      </div>
    `,
  });
}

export function forgotPasswordPage(opts: { error?: string; sent?: boolean; openDraw?: OpenDraw | undefined }): string {
  return layout({
    title: 'Forgotten password',
    active: 'login',
    ...(opts.openDraw ? { openDraw: opts.openDraw } : {}),
    body: `
      <div class="page-head">
        <h1>Forgotten password</h1>
        <p>Enter the email address on your account and we'll send you a link to reset your password.</p>
      </div>
      <div class="card stack" style="max-width:420px">
        ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
        ${
          opts.sent
            ? `<div class="banner"><span>✉️</span><span>If that email address is registered, a reset link is on its way &mdash; it expires in an hour.</span></div>`
            : `<form method="post" action="/forgot-password" class="stack">
                 <div class="field"><label for="email">Email address</label><input id="email" name="email" type="email" required autofocus autocomplete="username" /></div>
                 <button class="btn btn-primary btn-block" type="submit">Send reset link</button>
               </form>`
        }
        <p class="hint" style="text-align:center"><a href="/login">Back to log in</a></p>
      </div>
    `,
  });
}

export function resetPasswordPage(opts: {
  token: string;
  error?: string;
  openDraw?: OpenDraw | undefined;
}): string {
  return layout({
    title: 'Reset password',
    active: 'login',
    ...(opts.openDraw ? { openDraw: opts.openDraw } : {}),
    body: `
      <div class="page-head">
        <h1>Choose a new password</h1>
      </div>
      <div class="card stack" style="max-width:420px">
        ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
        <form method="post" action="/reset-password" class="stack">
          <input type="hidden" name="token" value="${escapeHtml(opts.token)}" />
          <div class="field"><label for="password">New password</label><input id="password" name="password" type="password" required minlength="10" autocomplete="new-password" autofocus />
            <p class="hint">At least 10 characters.</p></div>
          <button class="btn btn-primary btn-block" type="submit">Reset password</button>
        </form>
      </div>
    `,
  });
}

function ballGrid(name: string, selected: readonly number[]): string {
  const cells = Array.from({ length: 20 }, (_, i) => i + 1)
    .map(
      (n) =>
        `<label><input type="checkbox" name="${name}" value="${n}" ${selected.includes(n) ? 'checked' : ''} /><span class="ball">${n}</span></label>`,
    )
    .join('');
  return `<div class="ball-grid">${cells}</div>`;
}

/** GitHub #19: one picker per line. Line 1 is always shown; the rest appear with "Add another line". */
function linePicker(index: number, selected: readonly number[], shown: boolean): string {
  return `<div class="pick-line stack" data-line="${index}" style="gap:.6rem" ${shown ? '' : 'hidden'}>
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:.6rem;flex-wrap:wrap">
      <b style="font-size:.92rem">Line ${index}</b>
      <span class="hint tabular" style="margin:0"><span class="pick-count">0 of 4 selected</span>
        &middot; <button class="linkbtn quick-pick" type="button">🎲 Pick for me</button>${
          index > 1 ? ` &middot; <button class="linkbtn remove-line" type="button">Remove</button>` : ''
        }</span>
    </div>
    ${ballGrid(`line${index}`, selected)}
  </div>`;
}

export function drawPage(opts: {
  member: ViewMember;
  openDraw?: OpenDraw;
  stats?: DrawStats;
  currentEntry?: MyEntry;
  error?: string;
  /** Lines already picked, to show again alongside an error. */
  picked?: readonly (readonly number[])[];
}): string {
  const { openDraw: draw, stats } = opts;
  if (!draw) {
    return layout({
      title: 'Current draw',
      member: opts.member,
      active: 'draw',
      body: `<div class="page-head"><h1>Current draw</h1></div><div class="card"><p class="muted">No draw is open for entries right now &mdash; check back soon.</p></div>`,
    });
  }

  const stub = opts.currentEntry
    ? `<div class="card stack">
        <h3 style="font-size:.95rem;text-transform:none;letter-spacing:0">Ticket stub &mdash; prize draw no.</h3>
        <div style="display:flex;align-items:center;gap:.8rem">
          <span class="num" style="font-size:1.6rem;font-weight:700;color:var(--royal)">#${opts.currentEntry.id.slice(0, 8)}</span>
          <span class="pill pill-open">Entered ✓</span>
        </div>
        <p class="hint">This is your entry for this draw. Come back after it closes to see the result.</p>
      </div>`
    : '';

  return layout({
    title: 'Current draw',
    member: opts.member,
    active: 'draw',
    openDraw: draw,
    body: `
      <div class="page-head">
        <h1>${escapeHtml(drawHeading(draw))}</h1>
        <p>Drawn ${escapeHtml(drawWhen(draw))}${
          draw.entriesCloseAt ? ` &mdash; entries close ${escapeHtml(formatLondon(draw.entriesCloseAt))}` : ''
        }. Pick 4 numbers from 1 to 20, or let us pick for you.</p>
      </div>
      ${opts.error ? `<div class="error" style="margin-bottom:1rem">${escapeHtml(opts.error)}</div>` : ''}
      <div class="grid2">
        <div class="card stack">
          <h3 style="font-size:1rem;text-transform:none;letter-spacing:0">Your numbers for Draw ${draw.drawNumber}</h3>
          <form method="get" action="/draw/pay" id="pick-form" class="stack">
            ${Array.from({ length: MAX_LINES_PER_PURCHASE }, (_, i) =>
              linePicker(i + 1, opts.picked?.[i] ?? [], i === 0 || (opts.picked?.[i]?.length ?? 0) > 0),
            ).join('<hr class="divider">')}
            <div style="display:flex;gap:.6rem;flex-wrap:wrap">
              <button class="btn btn-ghost" type="button" id="add-line">+ Add another line</button>
              <button class="btn btn-primary" type="submit">Continue to payment →</button>
            </div>
          </form>
          <p class="hint">Each line is a separate entry in every draw it's paid for. Use different numbers on each line &mdash; up to ${MAX_LINES_PER_PURCHASE} lines in one payment.</p>
          <p class="hint">Pay by Direct Debit, or buy 4 or 12 draws by card, and your numbers stay entered automatically &mdash; no need to pick again next week.</p>
        </div>
        <div class="stack">
          <div class="card stack">
            <div class="stat"><span class="k">Estimated jackpot</span><span class="v">${formatEstimate(stats?.jackpotEstimatePence)}</span></div>
            <hr class="divider">
            <div class="row2">
              <div class="stat"><span class="k">Ticket price</span><span class="v" style="font-size:1.3rem">${formatPence(pence(200n))}</span></div>
              <div class="stat"><span class="k">Entries this week</span><span class="v" style="font-size:1.3rem">${stats?.entriesCount ?? 0}</span></div>
            </div>
          </div>
          ${stub}
        </div>
      </div>
      <script>
      (function(){
        var lines = document.querySelectorAll('.pick-line');
        var addLine = document.getElementById('add-line');
        function refreshAdd(){
          var hidden = document.querySelectorAll('.pick-line[hidden]');
          addLine.hidden = hidden.length === 0;
          // A divider only between lines that are showing.
          lines.forEach(function(line){
            var rule = line.previousElementSibling;
            if (rule && rule.tagName === 'HR') rule.hidden = line.hidden;
          });
        }
        lines.forEach(function(line){
          var count = line.querySelector('.pick-count');
          var boxes = line.querySelectorAll('input[type=checkbox]');
          function update(){
            count.textContent = line.querySelectorAll('input:checked').length + ' of 4 selected';
          }
          boxes.forEach(function(b){
            b.addEventListener('change', function(){
              if(line.querySelectorAll('input:checked').length > 4){ b.checked = false; }
              update();
            });
          });
          line.querySelector('.quick-pick').addEventListener('click', function(){
            boxes.forEach(function(b){ b.checked = false; });
            var pool = []; for(var i=0;i<boxes.length;i++) pool.push(i);
            for(var n=0;n<4;n++){
              var idx = Math.floor(Math.random()*pool.length);
              boxes[pool[idx]].checked = true;
              pool.splice(idx,1);
            }
            update();
          });
          var remove = line.querySelector('.remove-line');
          if (remove) remove.addEventListener('click', function(){
            // A removed line sends nothing: its boxes are cleared, not just hidden.
            boxes.forEach(function(b){ b.checked = false; });
            line.hidden = true;
            update();
            refreshAdd();
          });
          update();
        });
        addLine.addEventListener('click', function(){
          var next = document.querySelector('.pick-line[hidden]');
          if (next) next.hidden = false;
          refreshAdd();
        });
        refreshAdd();
      })();
      </script>
    `,
  });
}

function formatEstimate(p: bigint | undefined): string {
  return p === undefined ? '—' : formatPence(pence(p));
}

export type PaymentMethodChoice = 'card' | 'dd';

/**
 * GitHub #8: how to pay is the first choice. Card reveals the number-of-draws
 * selector and the card fields; Direct Debit shows only the bank fields — a
 * DD enters every draw until cancelled, so there is no number of draws.
 */
export function paymentPage(opts: {
  member: ViewMember;
  openDraw: OpenDraw;
  /** GitHub #19: every line being paid for, each bought for `blocks` draws. */
  selections: readonly (readonly number[])[];
  blocks: number;
  method?: PaymentMethodChoice;
  hasDirectDebit?: boolean;
  /** True for a real card provider: card details are entered on its hosted page, never on this one. */
  hostedCardPage?: boolean;
  error?: string;
}): string {
  const { selections, blocks, openDraw } = opts;
  const lineCount = Math.max(1, selections.length);
  const several = selections.length > 1;
  // A Direct Debit is set up for one line; several lines are paid by card.
  const method = several && opts.method === 'dd' ? 'card' : opts.method;
  const total = (size: number) => formatPence(pence(200n * BigInt(size) * BigInt(lineCount)));
  const selectionFields = selections
    .flatMap((line, i) => line.map((n) => `<input type="hidden" name="line${i + 1}" value="${n}" />`))
    .join('');
  const blockOption = (size: number, label: string) =>
    `<label class="radio-row"><input type="radio" name="blocks" value="${size}" ${blocks === size ? 'checked' : ''} />${label} <span class="amt">${total(size)}</span></label>`;
  const methodOption = (value: PaymentMethodChoice, title: string, detail: string, disabled = false) =>
    `<label class="method-choice"${disabled ? ' style="opacity:.55;cursor:not-allowed"' : ''}><input type="radio" name="method" value="${value}" ${method === value ? 'checked' : ''} ${disabled ? 'disabled' : 'required'} />
       <span><b>${title}</b><span class="hint">${detail}</span></span></label>`;
  const summaryLine = (size: number) =>
    several ? `${lineCount} lines × ${size} ${size === 1 ? 'draw' : 'draws'} (from Draw ${openDraw.drawNumber})` : `${size} × entry (from Draw ${openDraw.drawNumber})`;

  return layout({
    title: 'Payment',
    member: opts.member,
    active: 'draw',
    openDraw,
    body: `
      <div class="page-head">
        <h1>Pay for your entries</h1>
        <p>${formatPence(pence(200n))} buys one entry into one draw. Pay by card for a set number of draws, or by Direct Debit to stay entered every draw.</p>
      </div>
      ${opts.error ? `<div class="error" style="margin-bottom:1rem">${escapeHtml(opts.error)}</div>` : ''}
      <div class="grid2">
        <div class="card stack">
          <div class="stack" style="gap:.6rem">
            <h3 style="font-size:.95rem;text-transform:none;letter-spacing:0">Your numbers for Draw ${openDraw.drawNumber}</h3>
            ${selections
              .map(
                (line, i) =>
                  `<div style="display:flex;align-items:center;gap:.7rem">${several ? `<span class="hint" style="margin:0;min-width:3.2rem">Line ${i + 1}</span>` : ''}<div class="ball-row">${line
                    .map((n) => `<span class="ball picked">${n}</span>`)
                    .join('')}</div></div>`,
              )
              .join('')}
            <p class="hint" style="margin:0"><a href="/draw">Change numbers or add another line</a></p>
          </div>
          <form method="post" action="${method === 'dd' ? '/direct-debit/setup' : '/draw/enter'}" id="pay-form" class="stack">
            ${csrfField(opts.member.csrf)}
            ${selectionFields}
            <fieldset>
              <legend>How would you like to pay?</legend>
              <div class="method-choices">
                ${methodOption('card', 'Debit / credit card', several ? `Pay now for all ${lineCount} lines, 1, 4 or 12 draws each` : 'Pay now for 1, 4 or 12 draws')}
                ${
                  several
                    ? methodOption('dd', 'Direct Debit', 'One line of numbers per Direct Debit — pay for several lines by card', true)
                    : methodOption('dd', 'Direct Debit', `Entered every draw until you cancel — ${formatPence(pence(200n))} a draw`)
                }
              </div>
            </fieldset>
            ${
              opts.hasDirectDebit
                ? `<div class="banner"><span>ℹ️</span><span>You already pay by Direct Debit. Paying with the same numbers adds paid draws, which are used first while your Direct Debit pauses; different numbers add an extra entry alongside your existing ones.</span></div>`
                : ''
            }

            <div id="pay-card" class="stack" ${method === 'card' ? '' : 'hidden'}>
              <fieldset>
                <legend>${several ? 'How many draws for each line?' : 'How many draws?'}</legend>
                ${PURCHASE_BLOCK_SIZES.map((size) => blockOption(size, size === 1 ? '1 draw' : `${size} draws`)).join('')}
              </fieldset>
              ${
                opts.hostedCardPage
                  ? `<div class="banner"><span>🔒</span><span>You'll enter your card details on <b>Elavon's secure payment page</b> next. They never pass through this site.</span></div>`
                  : // Sandbox only: practice fields with no name attribute, so nothing typed here is ever posted.
                    `<div class="field"><label for="pc-name">Name on card</label><input id="pc-name" type="text" placeholder="Full name" autocomplete="off" data-required /></div>
              <div class="row2">
                <div class="field"><label for="pc-num">Card number</label><input id="pc-num" type="text" placeholder="4242 4242 4242 4242" autocomplete="off" data-required /></div>
                <div class="row2" style="grid-template-columns:1fr 1fr">
                  <div class="field"><label for="pc-exp">Expiry</label><input id="pc-exp" type="text" placeholder="MM/YY" autocomplete="off" data-required /></div>
                  <div class="field"><label for="pc-cvc">CVC</label><input id="pc-cvc" type="text" placeholder="123" autocomplete="off" data-required /></div>
                </div>
              </div>
              <div class="banner"><span>🧪</span><span><b>Sandbox payment</b> &mdash; any name, card number, expiry and CVC are accepted; this is a test transaction and no funds move.</span></div>`
              }
            </div>

            <div id="pay-dd" class="stack" ${method === 'dd' ? '' : 'hidden'}>
              <div class="field"><label for="dd-name">Name of account holder</label><input id="dd-name" name="dd-name" type="text" placeholder="Full name" autocomplete="off" data-required /></div>
              <div class="row2">
                <div class="field"><label for="dd-sort">Sort code</label><input id="dd-sort" name="dd-sort" type="text" placeholder="00-00-00" autocomplete="off" data-required /></div>
                <div class="field"><label for="dd-acc">Account number</label><input id="dd-acc" name="dd-acc" type="text" placeholder="12345678" autocomplete="off" data-required /></div>
              </div>
              <div class="banner"><span>🧪</span><span><b>Sandbox Direct Debit</b> &mdash; any name, sort code and account number are accepted; this is a test mandate and no funds move.</span></div>
            </div>

            <button class="btn btn-gold btn-block" type="submit" id="pay-submit" ${method ? '' : 'hidden'}>
              <span id="submit-card-label" ${method === 'card' ? '' : 'hidden'}>Pay <span class="blocks-total">${total(blocks)}</span> &amp; enter →</span>
              <span id="submit-dd-label" ${method === 'dd' ? '' : 'hidden'}>Set up Direct Debit →</span>
            </button>
            <p class="hint" style="text-align:center" id="pay-hint"></p>
          </form>
        </div>
        <div class="card stack" style="align-self:start">
          <h3 style="font-size:.95rem;text-transform:none;letter-spacing:0">Order summary</h3>
          <div id="summary-none" ${method ? 'hidden' : ''}><p class="muted">Choose how you'd like to pay.</p></div>
          <div id="summary-card" class="stack" ${method === 'card' ? '' : 'hidden'}>
            <div style="display:flex;justify-content:space-between;font-size:.9rem"><span id="summary-line">${summaryLine(blocks)}</span><span class="amt blocks-total">${total(blocks)}</span></div>
            <hr class="divider">
            <div style="display:flex;justify-content:space-between;font-weight:700"><span>Total due today</span><span class="amt blocks-total">${total(blocks)}</span></div>
            <p class="hint">Your numbers go into this draw now and each following draw automatically until the draws you've paid for run out.</p>
          </div>
          <div id="summary-dd" class="stack" ${method === 'dd' ? '' : 'hidden'}>
            <div style="display:flex;justify-content:space-between;font-size:.9rem"><span>Each draw, from Draw ${openDraw.drawNumber}</span><span class="amt">${formatPence(pence(200n))}</span></div>
            <hr class="divider">
            <div style="display:flex;justify-content:space-between;font-weight:700"><span>Due today</span><span class="amt">${formatPence(pence(0n))}</span></div>
            <p class="hint">Your numbers are entered into every draw until you cancel the Direct Debit from "My numbers".</p>
          </div>
        </div>
      </div>
      <script>
      (function(){
        var form = document.getElementById('pay-form');
        var submit = document.getElementById('pay-submit');
        var hint = document.getElementById('pay-hint');
        var HINTS = {
          card: ${JSON.stringify(opts.hostedCardPage ? "Card payments are processed securely by Elavon." : "Payments run through QOSFC's sandbox payment gateway while a real card acquirer is being set up.")},
          dd: "Direct Debit setup runs through QOSFC's sandbox Bacs bureau while a real route is being set up. No payment is taken today."
        };
        function show(id, on){ document.getElementById(id).hidden = !on; }
        function choose(method){
          var isCard = method === 'card';
          show('pay-card', isCard); show('pay-dd', !isCard);
          show('summary-none', false); show('summary-card', isCard); show('summary-dd', !isCard);
          show('submit-card-label', isCard); show('submit-dd-label', !isCard);
          submit.hidden = false;
          // Only the visible section's fields are required — and the number of
          // draws only exists for card: a Direct Debit has no end.
          document.querySelectorAll('#pay-card [data-required]').forEach(function(el){ el.required = isCard; });
          document.querySelectorAll('#pay-dd [data-required]').forEach(function(el){ el.required = !isCard; });
          document.querySelectorAll('input[name=blocks]').forEach(function(el){ el.disabled = !isCard; });
          form.action = isCard ? '/draw/enter' : '/direct-debit/setup';
          hint.textContent = HINTS[method];
        }
        document.querySelectorAll('input[name=method]').forEach(function(r){
          r.addEventListener('change', function(){ choose(r.value); });
          if (r.checked) choose(r.value);
        });
        var summary = document.getElementById('summary-line');
        var totals = document.querySelectorAll('.blocks-total');
        document.querySelectorAll('input[name=blocks]').forEach(function(r){
          r.addEventListener('change', function(){
            var amount = '£' + (Number(r.value) * 2 * ${lineCount}).toFixed(2);
            summary.textContent = ${JSON.stringify(Object.fromEntries(PURCHASE_BLOCK_SIZES.map((size) => [size, summaryLine(size)])))}[r.value];
            totals.forEach(function(el){ el.textContent = amount; });
          });
        });
      })();
      </script>
    `,
  });
}

export function purchaseReturnPage(opts: {
  member: ViewMember;
  openDraw?: OpenDraw | undefined;
  status: 'paid' | 'pending' | 'failed' | 'not_found';
  reason?: string;
  /** What was done with the payment (more weeks, or an extra entry; any Direct Debit pause). */
  message?: string;
}): string {
  const body =
    opts.status === 'paid'
      ? `<div class="page-head"><h1>You're in!</h1></div><div class="flash" style="white-space:pre-line">${escapeHtml(opts.message ?? 'Payment received — your entry is confirmed.')}</div>
         <p style="margin-top:1rem"><a class="btn btn-primary" href="/account">View my numbers</a></p>`
      : opts.status === 'pending'
        ? `<div class="page-head"><h1>Payment processing</h1></div><p class="muted">This can take a moment. Refresh this page shortly, or check "My numbers" later.</p>`
        : opts.status === 'failed'
          ? `<div class="page-head"><h1>Payment did not go through</h1></div><div class="error">${escapeHtml(opts.reason ?? 'The payment was not successful.')}</div>
             <p style="margin-top:1rem"><a class="btn btn-primary" href="/draw">Try again</a></p>`
          : `<div class="page-head"><h1>Unknown payment session</h1></div><p class="muted">We couldn't find that payment attempt.</p>`;
  return layout({ title: 'Payment', member: opts.member, active: 'draw', ...(opts.openDraw ? { openDraw: opts.openDraw } : {}), body });
}

export function directDebitReturnPage(opts: {
  member: ViewMember;
  openDraw?: OpenDraw | undefined;
  status: 'active' | 'failed' | 'not_found';
  reason?: string;
  /** What the Direct Debit does (new numbers alongside, or after paid draws run out). */
  message?: string;
}): string {
  const body =
    opts.status === 'active'
      ? `<div class="page-head"><h1>Direct Debit set up</h1></div><div class="flash">${escapeHtml(opts.message ?? 'Your Direct Debit is set up.')}</div>
         <p style="margin-top:1rem"><a class="btn btn-primary" href="/account">View my numbers</a></p>`
      : opts.status === 'failed'
        ? `<div class="page-head"><h1>Direct Debit setup did not complete</h1></div><div class="error">${escapeHtml(opts.reason ?? 'The mandate setup was not successful.')}</div>
           <p style="margin-top:1rem"><a class="btn btn-primary" href="/draw">Try again</a></p>`
        : `<div class="page-head"><h1>Unknown Direct Debit setup</h1></div><p class="muted">We couldn't find that setup attempt.</p>`;
  return layout({ title: 'Direct Debit', member: opts.member, active: 'draw', ...(opts.openDraw ? { openDraw: opts.openDraw } : {}), body });
}

function entryHistoryRow(e: MyEntry): string {
  const balls = e.selection
    .map((n) => `<span class="ball win" style="width:2rem;height:2rem;font-size:.8rem">${n}</span>`)
    .join('');
  const matched = e.winningNumbers ? e.selection.filter((n) => e.winningNumbers!.includes(n)).length : undefined;
  const won = e.drawStatus === 'settled' && matched === 4;
  const result =
    e.drawStatus !== 'settled'
      ? `<span class="pill pill-open">Open</span>`
      : won
        ? `<span class="pill pill-win">Jackpot won 🏆</span>`
        : `<span class="muted">${matched} matched</span>`;
  return `<tr><td class="num">${e.drawNumber}</td><td>${escapeHtml(e.drawDate)}</td><td><div class="ball-row">${balls}</div></td><td>${result}</td></tr>`;
}

export function accountPage(opts: {
  member: ViewMember;
  openDraw?: OpenDraw | undefined;
  /** Every set of numbers the member holds — each is entered separately. */
  standingSelections: readonly (readonly number[])[];
  entries: MyEntry[];
  directDebits: readonly DirectDebitStatus[];
  flash?: string;
}): string {
  const { entries, standingSelections, directDebits } = opts;
  const balls = (s: readonly number[]) => `<div class="ball-row">${s.map((n) => `<span class="ball picked">${n}</span>`).join('')}</div>`;
  const ddCard =
    directDebits.length > 0
      ? `<div class="card stack">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <h3 style="font-size:.95rem;text-transform:none;letter-spacing:0">Direct Debit</h3>
          <span class="pill pill-open">Active</span>
        </div>
        <p class="hint">${formatPence(pence(200n))} a draw for each set of numbers below. Draws you have paid for by card are used first; the Direct Debit pauses for those and resumes after.</p>
        ${directDebits
          .map(
            (dd) => `<div class="stack" style="gap:.4rem">
          ${dd.selection ? balls(dd.selection) : ''}
          <p class="hint">Set up ${escapeHtml(formatLondon(dd.since))}.</p>
          <form method="post" action="/direct-debit/cancel" onsubmit="return confirm('Cancel this Direct Debit? These numbers will no longer be entered by Direct Debit.');">
            ${csrfField(opts.member.csrf)}
            <input type="hidden" name="paymentMethodId" value="${escapeHtml(dd.id)}" />
            <button class="btn btn-ghost" type="submit">Cancel this Direct Debit</button>
          </form>
        </div>`,
          )
          .join('<hr class="divider">')}
      </div>`
      : '';
  const rows = entries.map(entryHistoryRow).join('\n');
  return layout({
    title: 'My numbers',
    member: opts.member,
    active: 'account',
    ...(opts.openDraw ? { openDraw: opts.openDraw } : {}),
    body: `
      <div class="page-head"><h1>My numbers</h1><p>Your numbers, upcoming entries and how they've fared.</p></div>
      ${opts.flash ? `<div class="flash" style="margin-bottom:1rem">${escapeHtml(opts.flash)}</div>` : ''}
      <div class="grid2">
        <div class="card stack">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <h3 style="font-size:.95rem;text-transform:none;letter-spacing:0">Currently entered</h3>
            ${standingSelections.length > 0 ? `<span class="pill pill-open">Entered ✓</span>` : ''}
          </div>
          ${standingSelections.length > 0 ? standingSelections.map(balls).join('') : `<p class="muted">No standing numbers yet.</p>`}
          <a class="btn btn-ghost" href="/draw">Add draws or numbers</a>
        </div>
        ${ddCard}
        <div class="card stack">
          <h3 style="font-size:.95rem;text-transform:none;letter-spacing:0">Entry history</h3>
          ${
            entries.length === 0
              ? `<p class="muted">No entries yet &mdash; <a href="/draw">enter the current draw</a>.</p>`
              : `<table><thead><tr><th>Draw</th><th>Date</th><th>Numbers</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>`
          }
        </div>
      </div>
    `,
  });
}

export function detailsPage(opts: {
  member: ViewMember;
  openDraw?: OpenDraw | undefined;
  details: MemberDetails;
  flash?: string;
}): string {
  const { details } = opts;
  const contactOption = (value: string, label: string) =>
    `<label class="toggle-note"><input type="radio" name="preferredContact" value="${value}" ${details.preferredContact === value ? 'checked' : ''} /> ${label}</label>`;
  return layout({
    title: 'My details',
    member: opts.member,
    active: 'details',
    ...(opts.openDraw ? { openDraw: opts.openDraw } : {}),
    body: `
      <div class="page-head"><h1>My details</h1><p>Keep this up to date &mdash; it's how we reach you if your numbers come up.</p></div>
      ${opts.flash ? `<div class="flash" style="margin-bottom:1rem">${escapeHtml(opts.flash)}</div>` : ''}
      <div class="grid2">
        <div class="card stack">
          <h3 style="font-size:.95rem;text-transform:none;letter-spacing:0">Contact</h3>
          <div class="row2">
            <div class="field"><label>Forename</label><input type="text" value="${escapeHtml(details.forename ?? '')}" disabled /></div>
            <div class="field"><label>Surname</label><input type="text" value="${escapeHtml(details.surname ?? '')}" disabled /></div>
          </div>
          <div class="field"><label>Email</label><input type="email" value="${escapeHtml(details.email ?? '')}" disabled /></div>
          <form method="post" action="/details" class="stack">
            ${csrfField(opts.member.csrf)}
            <div class="field"><label for="telephone">Mobile / telephone</label><input id="telephone" name="telephone" type="tel" value="${escapeHtml(details.telephone ?? '')}" /></div>
            <div class="field"><label for="address1">Address line 1</label><input id="address1" name="address1" type="text" value="${escapeHtml(details.address1 ?? '')}" /></div>
            <div class="field"><label for="address2">Address line 2</label><input id="address2" name="address2" type="text" value="${escapeHtml(details.address2 ?? '')}" /></div>
            <div class="row2">
              <div class="field"><label for="address3">Town</label><input id="address3" name="address3" type="text" value="${escapeHtml(details.address3 ?? '')}" /></div>
              <div class="field"><label for="postCode">Postcode</label><input id="postCode" name="postCode" type="text" value="${escapeHtml(details.postCode ?? '')}" /></div>
            </div>
            <span class="sep-label">Notify me by</span>
            <div style="display:flex;gap:1.2rem">
              ${contactOption('email', 'Email')}
              ${contactOption('phone', 'Phone')}
              ${contactOption('post', 'Post')}
            </div>
            <button class="btn btn-primary" type="submit" style="align-self:flex-start">Save changes</button>
          </form>
        </div>
        <div class="card stack" style="align-self:start">
          <h3 style="font-size:.95rem;text-transform:none;letter-spacing:0">Prize payout account</h3>
          <div class="banner"><span>🏗️</span><span>Online payout account management is coming soon. Winnings are currently arranged directly with QOSFC.</span></div>
        </div>
      </div>
    `,
  });
}

function pastDrawRow(d: SettledDraw): string {
  const balls = d.winningNumbers.map((n) => `<span class="ball win" style="width:2rem;height:2rem;font-size:.8rem">${n}</span>`).join('');
  const rolled = d.rolloverOutPence !== null && BigInt(d.rolloverOutPence) > 0n;
  return `<tr>
    <td class="num">${d.drawNumber}</td>
    <td>${escapeHtml(d.drawDate)}</td>
    <td><div class="ball-row">${balls}</div></td>
    <td class="amt">${d.jackpotPaidPence !== null ? formatPence(pence(BigInt(d.jackpotPaidPence))) : '—'}</td>
    <td>${rolled ? `<span class="pill pill-rollover">Rolled over</span>` : `<span class="pill pill-win">Won — shared by ${d.winnersCount ?? 0}</span>`}</td>
  </tr>`;
}

export function pastDrawsPage(opts: { member?: ViewMember; openDraw?: OpenDraw | undefined; draws: SettledDraw[] }): string {
  const rows = opts.draws.map(pastDrawRow).join('\n');
  return layout({
    title: 'Past draws',
    ...(opts.member ? { member: opts.member } : {}),
    active: 'past',
    ...(opts.openDraw ? { openDraw: opts.openDraw } : {}),
    body: `
      <div class="page-head"><h1>Past draws</h1><p>Winning numbers and outcomes for recent weeks.</p></div>
      <div class="card">
        ${
          opts.draws.length === 0
            ? '<p class="muted">No draws have been settled yet.</p>'
            : `<table><thead><tr><th>Draw</th><th>Date</th><th>Winning numbers</th><th>Jackpot</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table>`
        }
      </div>
    `,
  });
}
