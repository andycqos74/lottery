import { formatPence, pence } from '@qosfc/domain';
import type { DrawStats, LifetimeTotals, MemberDetails, MemberLine, MyEntry, OpenDraw, RevenueSplit, SettledDraw } from './db.js';
import { MAX_LINES_PER_PURCHASE, PURCHASE_BLOCK_SIZES } from './entries.js';
import type { DirectDebitStatus } from './direct-debit.js';
import { assetUrl } from './assets.js';

/*
 * The member-facing pages, in the Queen of the South FC identity
 * (docs/design_handoff_public_pages). Server-rendered strings, as before — but
 * styles and behaviour live in apps/api/public/site.css and site.js, never
 * inline: the site is served under a strict CSP (deploy/compose/Caddyfile)
 * that blocks inline <style>, <script> and style="" attributes.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const LONDON_DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const LONDON_LONG_DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long' });
const LONDON_HOUR = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', minute: '2-digit', hour12: true });
const SHORT_DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });

/** All draw times are UK times, whatever timezone the server runs in. */
function formatLondon(value: Date): string {
  return LONDON_DATE_TIME.format(value);
}

/** "Saturday 10 October · 7pm" — the landing hero's draw time. */
function formatLondonLong(value: Date): string {
  const time = LONDON_HOUR.format(value).replace(':00', '').replace(/\s/g, '').toLowerCase();
  return `${LONDON_LONG_DATE.format(value).replace(',', '')} · ${time}`;
}

/** "Sat 3 Oct" from a draw's calendar date (YYYY-MM-DD). */
function formatDrawDate(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? isoDate : SHORT_DATE.format(date).replace(',', '');
}

function drawWhen(draw: OpenDraw): string {
  return draw.drawAt ? formatLondon(draw.drawAt) : draw.drawDate;
}

function drawHeading(draw: OpenDraw): string {
  return draw.name ? `${draw.name} — Draw No. ${draw.drawNumber}` : `Draw No. ${draw.drawNumber}`;
}

/** Whole pounds for headline figures ("£1,240"), falling back to pence so an odd amount is never misstated. */
function formatMoney(p: bigint): string {
  return p % 100n === 0n ? `£${(p / 100n).toLocaleString('en-GB')}` : formatPence(pence(p));
}

function moneyOrDash(raw: string | null): string {
  return raw === null || BigInt(raw) === 0n ? '—' : formatMoney(BigInt(raw));
}

function csrfField(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />`;
}

/** Carries a post-login destination (e.g. the landing page's picks) through log in and sign up. */
function nextField(next: string | undefined): string {
  return next ? `<input type="hidden" name="next" value="${escapeHtml(next)}" />` : '';
}

function withNext(href: string, next: string | undefined): string {
  return next ? `${href}?next=${encodeURIComponent(next)}` : href;
}

const icon = (name: string) => `<i class="fa ${name}" aria-hidden="true"></i>`;
const arrow = icon('fa-arrow-right');

function notice(iconName: string, html: string): string {
  return `<div class="notice">${icon(iconName)}<span>${html}</span></div>`;
}

function errorNotice(message: string | undefined): string {
  return message ? `<div class="notice-error" role="alert">${escapeHtml(message)}</div>` : '';
}

function jaggedDivider(onNavy = false): string {
  return `<svg class="jag${onNavy ? ' on-navy' : ''}" viewBox="0 0 400 10" preserveAspectRatio="none" aria-hidden="true"><polyline points="0,5 50,2 110,8 170,3 240,7 300,2 360,7 400,4"></polyline></svg>`;
}

function primaryButton(label: string, attrs = ''): string {
  return `<button class="btn-primary" type="submit" ${attrs}><span>${label}</span>${arrow}</button>`;
}

function field(opts: { label: string; input: string; hint?: string; className?: string }): string {
  return `<label class="field${opts.className ? ` ${opts.className}` : ''}">${opts.label}${opts.input}${opts.hint ? `<span class="hint">${opts.hint}</span>` : ''}</label>`;
}

export interface ViewMember {
  readonly forename: string | null;
  readonly csrf: string;
}

// ── Shell ───────────────────────────────────────────────────────────────────

interface MenuItem {
  readonly label: string;
  readonly href: string;
}

const LOGGED_OUT_MENU: MenuItem[] = [
  { label: 'Home', href: '/' },
  { label: 'Current draw', href: '/draw' },
  { label: 'Results', href: '/past-draws' },
  { label: 'How to play', href: '/#how-to-play' },
  { label: 'Good causes', href: '/#good-causes' },
  { label: 'Log in / Sign up', href: '/login' },
];

const LOGGED_IN_MENU: MenuItem[] = [
  { label: 'Home', href: '/' },
  { label: 'Current draw', href: '/draw' },
  { label: 'My numbers', href: '/account' },
  { label: 'My details', href: '/details' },
  { label: 'Results', href: '/past-draws' },
];

// The club has not supplied these pages yet; the links are placeholders until it does.
const FOOTER_LINKS: MenuItem[] = [
  { label: 'Rules', href: '#' },
  { label: 'Privacy', href: '#' },
  { label: 'Play responsibly', href: '#' },
  { label: 'Contact', href: '#' },
];

function nav(member: ViewMember | undefined): string {
  const items = (member ? LOGGED_IN_MENU : LOGGED_OUT_MENU).map((m) => `<a href="${m.href}">${escapeHtml(m.label)}</a>`).join('');
  const logout = member
    ? `<form method="post" action="/logout">${csrfField(member.csrf)}<button type="submit">Log out</button></form>`
    : '';
  return `<nav class="site-nav" aria-label="Main">
    <a class="brand" href="/">
      <img src="/assets/img/qos-crest.png" alt="Queen of the South FC" width="52" height="52" />
      <span class="brand-text"><span class="brand-club">Queen of the South FC</span><span class="brand-name">The Doonhamers Draw</span></span>
    </a>
    <div class="nav-actions">
      <button type="button" class="menu-btn" aria-expanded="false" aria-controls="site-menu"><span class="menu-word">Menu</span><span class="menu-glyph" aria-hidden="true">&#9776;</span></button>
      <a class="profile-link" href="${member ? '/account' : '/login'}" title="${member ? 'My account' : 'Log in'}" aria-label="${member ? 'My account' : 'Log in'}">${icon('fa-user')}</a>
    </div>
    <div class="site-menu" id="site-menu" hidden>${items}${logout}</div>
  </nav>`;
}

function footer(): string {
  return `<footer class="site-footer">
    <img src="/assets/img/qos-crest.png" alt="" width="42" height="42" />
    <span>The Doonhamers Draw · Queen of the South FC · Palmerston Park, Dumfries</span>
    <div class="footer-links">${FOOTER_LINKS.map((l) => `<a href="${l.href}">${escapeHtml(l.label)}</a>`).join('')}</div>
  </footer>`;
}

function document_(opts: { title: string; pageClass: 'page-inner' | 'page-landing'; content: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(opts.title)} — The Doonhamers Draw</title>
  <link rel="icon" href="/assets/img/qos-crest.png" />
  <link rel="preload" href="/assets/fonts/merriweather-sans-0.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="preload" href="/assets/fonts/open-sans-1.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="stylesheet" href="${assetUrl('fonts.css')}" />
  <link rel="stylesheet" href="${assetUrl('site.css')}" />
  <script src="${assetUrl('site.js')}" defer></script>
</head>
<body class="${opts.pageClass}">
  <div class="site">
${opts.content}
  </div>
</body>
</html>`;
}

/** Every page except the landing page: nav, header, slanted band, main, footer. */
function layout(opts: {
  title: string;
  eyebrow: string;
  heading: string;
  lede?: string;
  body: string;
  member?: ViewMember | undefined;
}): string {
  return document_({
    title: opts.title,
    pageClass: 'page-inner',
    content: `${nav(opts.member)}
    <header class="page-header">
      <div class="page-header-text" data-reveal="left">
        <span class="eyebrow">${escapeHtml(opts.eyebrow)}</span>
        <h1>${escapeHtml(opts.heading)}</h1>
        ${opts.lede ? `<p class="lede">${opts.lede}</p>` : ''}
      </div>
      <div class="page-header-art" aria-hidden="true">
        <div class="art-sky"></div>
        <div class="art-navy" data-reveal="right"></div>
        <div class="art-mid" data-reveal="right" data-delay="120"></div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points="70,0 58,34 63,58 52,100" fill="none" stroke="#009fff" stroke-width="3" vector-effect="non-scaling-stroke"></polyline></svg>
      </div>
    </header>
    <div class="slant-band" aria-hidden="true"><div class="slant-top"></div><div class="slant-bottom"></div></div>
    <main class="page-main">${opts.body}</main>
    ${footer()}`,
  });
}

// ── Landing ─────────────────────────────────────────────────────────────────

function ballPicker(name: string, selected: readonly number[]): string {
  return Array.from({ length: 20 }, (_, i) => i + 1)
    .map(
      (n) =>
        `<label class="ball-pick"><input type="checkbox" name="${name}" value="${n}" ${selected.includes(n) ? 'checked' : ''} aria-label="Number ${n}" /><span>${n}</span></label>`,
    )
    .join('');
}

function segmentedDraws(opts: { selected: number; price: (size: number) => string; compact?: boolean; legend: string }): string {
  const options = PURCHASE_BLOCK_SIZES.map(
    (size) =>
      `<label><input type="radio" name="blocks" value="${size}" ${opts.selected === size ? 'checked' : ''} /><b>${size === 1 ? '1 draw' : `${size} draws`}</b>${
        opts.compact ? '' : `<span>${opts.price(size)}</span>`
      }</label>`,
  ).join('');
  return `<div class="segmented${opts.compact ? ' compact' : ''}" role="radiogroup" aria-label="${escapeHtml(opts.legend)}">${options}</div>`;
}

export function landingPage(opts: {
  member?: ViewMember | undefined;
  openDraw?: OpenDraw | undefined;
  stats?: DrawStats | undefined;
  lastDraw?: SettledDraw | undefined;
  totals: LifetimeTotals;
  split: RevenueSplit;
}): string {
  const { openDraw: draw, stats, lastDraw, totals, split } = opts;
  const pct = (bp: number) => `${Math.round(bp / 100)}%`;
  const goodCausePence = Math.round(split.goodCauseBp / 100);

  const heroText = draw
    ? `<span class="hero-eyebrow">Draw No. ${draw.drawNumber}${draw.drawAt ? ` · ${escapeHtml(formatLondonLong(draw.drawAt))}` : ''}</span>
        <h1>Estimated jackpot</h1>
        <div class="jackpot">
          <div class="jackpot-highlight" aria-hidden="true"></div>
          <div class="jackpot-figure" data-pulse data-count-to="${stats?.jackpotEstimatePence ?? 0}">${stats ? formatMoney(stats.jackpotEstimatePence) : '—'}</div>
        </div>
        ${
          draw.drawAt
            ? `<div class="countdown" data-countdown="${draw.drawAt.toISOString()}" aria-label="Time until the draw">
            <div class="countdown-box"><b data-unit="d">--</b><span>Days</span></div>
            <div class="countdown-box"><b data-unit="h">--</b><span>Hours</span></div>
            <div class="countdown-box"><b data-unit="m">--</b><span>Mins</span></div>
            <div class="countdown-box"><b data-unit="s">--</b><span>Secs</span></div>
          </div>
          <span class="countdown-live" hidden>Draw in progress</span>`
            : ''
        }
        <div class="hero-ctas">
          <a class="btn-primary" href="#easy-entry">Play this week ${arrow}</a>
          <a class="btn-secondary" href="#how-to-play">How it works</a>
        </div>`
    : `<span class="hero-eyebrow">The Doonhamers Draw</span>
        <p class="hero-soon">Next draw coming soon</p>
        <div class="hero-ctas"><a class="btn-secondary" href="#how-to-play">How it works</a></div>`;

  let band = '';
  if (lastDraw) {
    const paid = BigInt(lastDraw.jackpotPaidPence ?? '0');
    const rolled = BigInt(lastDraw.rolloverOutPence ?? '0');
    const winners = lastDraw.winnersCount ?? 0;
    band = `<section class="last-band" aria-label="Last draw">
      <div class="last-band-sky" aria-hidden="true"></div>
      <div class="last-band-navy">
        <div class="last-band-content" data-reveal="up">
          <div class="last-title"><b>Last draw</b><span>No. ${lastDraw.drawNumber} · ${escapeHtml(formatDrawDate(lastDraw.drawDate))}</span></div>
          <div class="balls">${lastDraw.winningNumbers.map((n) => `<span class="ball ball-band" data-ball>${n}</span>`).join('')}</div>
          <div class="band-stat push"><span class="stat-label">Jackpot</span><span class="stat-value" data-pulse>${formatMoney(paid + rolled)}</span></div>
          ${
            winners > 0
              ? `<div class="band-stat"><span class="stat-label">Winners</span><span class="stat-value">${winners} <small>${formatMoney(paid / BigInt(winners))} each</small></span></div>`
              : `<div class="band-stat"><span class="stat-label">Rolled over</span><span class="stat-value">${formatMoney(rolled)}</span></div>`
          }
        </div>
      </div>
    </section>`;
  }

  const easyEntry = draw
    ? `<section id="easy-entry" class="section-centred easy-entry">
      <div class="easy-intro" data-reveal="left">
        <span class="sky-eyebrow">Easy entry</span>
        <h2 class="section-h2">Pick your four for Draw ${draw.drawNumber}</h2>
        <p class="body-copy">Tap four numbers or use Lucky Dip. Choose how many draws, then pay by card or Direct Debit on the next step.</p>
      </div>
      <form class="easy-panel" id="easy-form" method="get" action="/draw/pay" data-reveal="right" data-delay="120">
        <div class="easy-grid-wrap"><div class="easy-grid" role="group" aria-label="Pick four numbers">${ballPicker('line1', [])}</div></div>
        <div class="easy-rule" aria-hidden="true"></div>
        <div class="easy-controls">
          <span class="easy-count" aria-live="polite">0 of 4 selected</span>
          <button type="button" class="btn-lucky" id="easy-lucky">${icon('fa-random')} Lucky Dip</button>
          ${segmentedDraws({ selected: 1, price: () => '', compact: true, legend: 'How many draws' })}
          <button class="btn-primary" type="submit" id="easy-submit"><span class="label">Continue to payment</span>${arrow}</button>
        </div>
      </form>
    </section>`
    : '';

  const steps = [
    ['01', 'Create an account', 'Register with your name, email address and a password.'],
    ['02', 'Pick 4 numbers', 'Choose 4 numbers from 1 to 20, or use Lucky Dip. Add more lines if you like.'],
    ['03', 'Pay £2 per draw', 'Pay by card for 1, 4 or 12 draws, or by Direct Debit to stay entered every draw.'],
    ['04', 'Watch the draw', 'Match all 4 to share the jackpot. If nobody does, it rolls over to the next draw.'],
  ]
    .map(
      ([num, title, body], i) =>
        `<div class="step" data-reveal="up"${i > 0 ? ` data-delay="${i * 140}"` : ''}><span class="step-num">${num}</span><h3>${title}</h3><p>${body}</p></div>`,
    )
    .join('');

  return document_({
    title: 'Home',
    pageClass: 'page-landing',
    content: `${nav(opts.member)}
    <header class="hero">
      <div class="hero-text" data-reveal="left">${heroText}</div>
      <div class="hero-photo">
        <div class="hero-photo-sky" aria-hidden="true"></div>
        <div class="hero-photo-img" data-reveal="right">
          <picture><source srcset="/assets/img/landing-hero.webp" type="image/webp" /><img src="/assets/img/landing-hero.jpg" alt="Queen of the South players celebrating a goal in front of the home crowd at Palmerston Park" width="1200" height="800" /></picture>
        </div>
      </div>
    </header>
    ${band}
    <main>
    ${easyEntry}
    <section id="how-to-play" class="how-to-play">
      <svg class="jag-edge" viewBox="0 0 1280 40" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,0 1280,0 1280,14 1130,30 980,8 820,26 650,6 500,32 330,10 170,28 0,12"></polygon></svg>
      <h2 class="section-h2" data-reveal="left">How to play</h2>
      <div class="steps">${steps}</div>
    </section>
    <section class="section-centred totals" aria-label="Where the money goes">
      <div class="total span-all" data-reveal="left">
        <span class="total-label">Prize money paid out</span>
        <span class="total-value" data-count-to="${totals.prizePaidPence}">${formatMoney(totals.prizePaidPence)}</span>
        <svg class="total-under" viewBox="0 0 360 18" preserveAspectRatio="none" aria-hidden="true"><polyline points="0,12 50,4 110,14 170,3 230,13 290,5 360,10"></polyline></svg>
        <span class="total-caption">to winners since the draw began</span>
      </div>
      <div class="split" data-reveal="up">
        <div class="split-bar" data-split="${split.prizeBp},${split.goodCauseBp},${split.adminBp}" aria-hidden="true"><i class="s-prize"></i><i class="s-trust"></i><i class="s-costs"></i></div>
        <div class="split-legend">
          <span class="l-prize"><i></i>${pct(split.prizeBp)} Prize fund</span>
          <span class="l-trust"><i></i>${pct(split.goodCauseBp)} Community Trust</span>
          <span class="l-costs"><i></i>${pct(split.adminBp)} Running costs</span>
        </div>
      </div>
    </section>
    <section id="good-causes" class="community">
      <svg class="jag-edge" viewBox="0 0 1280 40" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,0 1280,0 1280,22 1120,6 960,30 800,10 640,34 480,8 320,28 160,12 0,26"></polygon></svg>
      <div class="community-grid">
        <div class="community-photo" data-reveal="left">
          <div class="community-photo-sky" aria-hidden="true"></div>
          <div class="community-photo-img"><picture><source srcset="/assets/img/community-trust.webp" type="image/webp" /><img src="/assets/img/community-trust.jpg" alt="Queen of the South Community Trust volunteers at a community event in Dumfries" width="1040" height="693" loading="lazy" /></picture></div>
        </div>
        <div class="community-text" data-reveal="right">
          <span class="sky-eyebrow">Good causes</span>
          <h3>Playing supports the community</h3>
          <p>${goodCausePence}p in every £1 goes to the Queen of the South Community Trust. Every line you enter helps fund its work across Dumfries and Galloway.</p>
          <a class="more-link" href="#">About the Trust ${icon('fa-angle-double-right')}</a>
        </div>
      </div>
    </section>
    </main>
    ${footer()}`,
  });
}

// ── Sign up, log in, password reset ─────────────────────────────────────────

export function registerPage(opts: {
  error?: string;
  openDraw?: OpenDraw | undefined;
  next?: string | undefined;
  split?: RevenueSplit | undefined;
}): string {
  const goodCausePence = Math.round((opts.split?.goodCauseBp ?? 4000) / 100);
  const why = [
    ['fa-heart', `${goodCausePence}p in every £1 goes to the Queen of the South Community Trust.`],
    ['fa-ticket', 'Entries are £2 each. Pay per draw, or in blocks of 4 or 12 to skip the top-up.'],
    ['fa-trophy', "Match all 4 of 4 numbers to share that week's jackpot. No match, no worries — it rolls into next week's."],
  ]
    .map(([name, text]) => `<div class="why-row"><span class="why-icon">${icon(name!)}</span><span>${escapeHtml(text!)}</span></div>`)
    .join('');
  return layout({
    title: 'Sign up',
    eyebrow: 'Sign up',
    heading: 'Join the draw',
    lede: 'Pick 4 numbers from 1&ndash;20, every week, for £2. Every entry supports Queen of the South FC &mdash; match all four and share the jackpot.',
    body: `
      <div class="cols">
        <form method="post" action="/register" class="panel" data-reveal="left">
          <h2>Create your account</h2>
          ${errorNotice(opts.error)}
          ${nextField(opts.next)}
          <div class="field-pair">
            ${field({ label: 'Forename', input: '<input id="forename" name="forename" type="text" required autofocus autocomplete="given-name" />' })}
            ${field({ label: 'Surname', input: '<input id="surname" name="surname" type="text" required autocomplete="family-name" />' })}
          </div>
          ${field({ label: 'Email address', input: '<input id="email" name="email" type="email" required autocomplete="username" />' })}
          ${field({ label: 'Password', input: '<input id="password" name="password" type="password" required minlength="10" autocomplete="new-password" />', hint: 'At least 10 characters.' })}
          ${primaryButton('Create my account')}
          <p class="center-text">Already a member? <a href="${withNext('/login', opts.next)}">Log in</a></p>
        </form>
        <div class="panel-navy" data-reveal="right" data-delay="120">
          <h2>Why join the Draw</h2>
          ${why}
        </div>
      </div>
    `,
  });
}

export function loginPage(opts: { error?: string; notice?: string; openDraw?: OpenDraw | undefined; next?: string | undefined }): string {
  return layout({
    title: 'Log in',
    eyebrow: 'Log in',
    heading: 'Welcome back',
    lede: "Log in to check this week's numbers, top up your entries, or see what you've won.",
    body: `
      <form method="post" action="/login" class="panel narrow" data-reveal="left">
        ${errorNotice(opts.error)}
        ${opts.notice ? notice('fa-check', escapeHtml(opts.notice)) : ''}
        ${nextField(opts.next)}
        ${field({ label: 'Email address', input: '<input id="email" name="email" type="email" required autofocus autocomplete="username" />' })}
        ${field({ label: 'Password', input: '<input id="password" name="password" type="password" required autocomplete="current-password" />' })}
        ${primaryButton('Log in')}
        <a class="center-link" href="/forgot-password">Forgotten your password?</a>
        ${jaggedDivider()}
        <p class="center-text">New to the Draw? <a href="${withNext('/register', opts.next)}">Create an account</a></p>
      </form>
    `,
  });
}

export function forgotPasswordPage(opts: { error?: string; sent?: boolean; openDraw?: OpenDraw | undefined }): string {
  return layout({
    title: 'Forgotten password',
    eyebrow: 'Log in',
    heading: 'Forgotten password',
    lede: "Enter the email address on your account and we'll send you a link to reset your password.",
    body: `
      <div class="panel narrow" data-reveal="left">
        ${errorNotice(opts.error)}
        ${
          opts.sent
            ? notice('fa-envelope', 'If that email address is registered, a reset link is on its way &mdash; it expires in an hour.')
            : `<form method="post" action="/forgot-password" class="stack">
                 ${field({ label: 'Email address', input: '<input id="email" name="email" type="email" required autofocus autocomplete="username" />' })}
                 ${primaryButton('Send reset link')}
               </form>`
        }
        <a class="center-link" href="/login">Back to log in</a>
      </div>
    `,
  });
}

export function resetPasswordPage(opts: { token: string; error?: string; openDraw?: OpenDraw | undefined }): string {
  return layout({
    title: 'Reset password',
    eyebrow: 'Log in',
    heading: 'Choose a new password',
    lede: 'Use at least 10 characters.',
    body: `
      <form method="post" action="/reset-password" class="panel narrow" data-reveal="left">
        ${errorNotice(opts.error)}
        <input type="hidden" name="token" value="${escapeHtml(opts.token)}" />
        ${field({ label: 'New password', input: '<input id="password" name="password" type="password" required minlength="10" autocomplete="new-password" autofocus />', hint: 'At least 10 characters.' })}
        ${primaryButton('Reset password')}
      </form>
    `,
  });
}

// ── Current draw ────────────────────────────────────────────────────────────

/** GitHub #19: one picker per line. Line 1 is always shown; the rest appear with "Add another line". */
function linePicker(index: number, selected: readonly number[], shown: boolean): string {
  return `<div class="pick-line" data-line="${index}" ${shown ? '' : 'hidden'}>
    <div class="pick-line-head">
      <b>Line ${index}</b>
      <div class="pick-line-tools">
        <span class="pick-count" aria-live="polite">${selected.length} of 4 selected</span>
        <button class="btn-small quick-pick" type="button">${icon('fa-random')} Pick for me</button>
        ${index > 1 ? `<button class="btn-small plain remove-line" type="button">Remove</button>` : ''}
      </div>
    </div>
    <div class="ball-grid" role="group" aria-label="Line ${index} numbers">${ballPicker(`line${index}`, selected)}</div>
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
      eyebrow: 'Current draw',
      heading: 'Current draw',
      member: opts.member,
      body: `<div class="panel narrow" data-reveal="left"><p class="body-copy">No draw is open for entries right now &mdash; check back soon.</p></div>`,
    });
  }

  const stub = opts.currentEntry
    ? `<div class="panel panel-white">
        <span class="stat-label tight">Ticket stub &mdash; prize draw no.</span>
        <div class="stub-row"><span class="stub-no">#${escapeHtml(opts.currentEntry.id.slice(0, 8))}</span><span class="badge">${icon('fa-check')} Entered</span></div>
        <p class="small-hint">This is your entry for this draw. Come back after it closes to see the result.</p>
      </div>`
    : '';

  return layout({
    title: 'Current draw',
    eyebrow: `Draw No. ${draw.drawNumber} · ${drawWhen(draw)}`,
    heading: draw.name ? drawHeading(draw) : 'Current draw',
    lede: `Drawn ${escapeHtml(drawWhen(draw))}${
      draw.entriesCloseAt ? ` &mdash; entries close ${escapeHtml(formatLondon(draw.entriesCloseAt))}` : ''
    }. Pick 4 numbers from 1 to 20, or let us pick for you.`,
    member: opts.member,
    body: `
      <div class="flex-cols">
        <div class="col-main panel panel-tight" data-reveal="left">
          <h2 class="h-22">Your numbers for Draw ${draw.drawNumber}</h2>
          ${errorNotice(opts.error)}
          <form method="get" action="/draw/pay" id="pick-form" class="stack">
            ${Array.from({ length: MAX_LINES_PER_PURCHASE }, (_, i) =>
              linePicker(i + 1, opts.picked?.[i] ?? [], i === 0 || (opts.picked?.[i]?.length ?? 0) > 0),
            ).join('')}
            <div class="btn-row">
              <button class="btn-secondary small" type="button" id="add-line">+ Add another line</button>
              <button class="btn-primary inline" type="submit">Continue to payment ${arrow}</button>
            </div>
          </form>
          <p class="small-hint">Each line is a separate entry in every draw it's paid for. Use different numbers on each line &mdash; up to ${MAX_LINES_PER_PURCHASE} lines in one payment.</p>
        </div>
        <div class="col-side" data-reveal="right" data-delay="120">
          <div class="panel-navy angle-b">
            <span class="stat-label">Estimated jackpot</span>
            <span class="stat-value v-64" data-pulse>${stats ? formatMoney(stats.jackpotEstimatePence) : '—'}</span>
            <svg class="jag-under" viewBox="0 0 200 12" aria-hidden="true"><polyline points="0,8 40,3 80,10 120,2 160,9 200,4"></polyline></svg>
          </div>
          <div class="stats-panel">
            <div class="stat"><span class="stat-label tight">Ticket price</span><span class="stat-value v-28">${formatPence(pence(200n))}</span></div>
            <div class="stat"><span class="stat-label tight">Entries this week</span><span class="stat-value v-28">${stats?.entriesCount ?? 0}</span></div>
            <p class="small-hint">Pay by Direct Debit, or buy 4 or 12 draws by card, and your numbers stay entered automatically &mdash; no need to pick again next week.</p>
          </div>
          ${stub}
        </div>
      </div>
    `,
  });
}

// ── Payment ─────────────────────────────────────────────────────────────────

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
  const methodOption = (value: PaymentMethodChoice, iconName: string, title: string, detail: string, disabled = false) =>
    `<label class="method${disabled ? ' is-disabled' : ''}"><input type="radio" name="method" value="${value}" ${method === value ? 'checked' : ''} ${disabled ? 'disabled' : 'required'} />
       ${icon(iconName)}<span class="method-text"><b>${title}</b><span>${detail}</span></span></label>`;
  const summaryLine = (size: number) =>
    several ? `${lineCount} lines × ${size} ${size === 1 ? 'draw' : 'draws'} (from Draw ${openDraw.drawNumber})` : `${size} × entry (from Draw ${openDraw.drawNumber})`;
  const hints = {
    card: opts.hostedCardPage ? 'Card payments are processed securely by Elavon.' : "Payments run through QOSFC's sandbox payment gateway while a real card acquirer is being set up.",
    dd: "Direct Debit setup runs through QOSFC's sandbox Bacs bureau while a real route is being set up. No payment is taken today.",
  };
  const summaries = Object.fromEntries(PURCHASE_BLOCK_SIZES.map((size) => [size, summaryLine(size)]));

  return layout({
    title: 'Payment',
    eyebrow: `Draw No. ${openDraw.drawNumber}`,
    heading: 'Pay for your entries',
    lede: `${formatPence(pence(200n))} buys one entry into one draw. Pay by card for a set number of draws, or by Direct Debit to stay entered every draw.`,
    member: opts.member,
    body: `
      <div class="flex-cols">
        <form method="post" action="${method === 'dd' ? '/direct-debit/setup' : '/draw/enter'}" id="pay-form" class="col-main panel panel-tight" data-reveal="left"
              data-hints="${escapeHtml(JSON.stringify(hints))}" data-summaries="${escapeHtml(JSON.stringify(summaries))}" data-lines="${lineCount}">
          ${errorNotice(opts.error)}
          ${csrfField(opts.member.csrf)}
          ${selectionFields}
          <div class="stack-10">
            <h2 class="h-20">Your numbers for Draw ${openDraw.drawNumber}</h2>
            ${selections
              .map(
                (line, i) =>
                  `<div class="pay-line">${several ? `<span class="pay-line-label">Line ${i + 1}</span>` : ''}<div class="balls">${line
                    .map((n) => `<span class="ball ball-44">${n}</span>`)
                    .join('')}</div></div>`,
              )
              .join('')}
            <a class="center-link" href="/draw">Change numbers or add another line</a>
          </div>
          <div class="stack-10">
            <span class="field-label" id="method-label">How would you like to pay?</span>
            <div class="methods" role="radiogroup" aria-labelledby="method-label">
              ${methodOption('card', 'fa-credit-card', 'Debit / credit card', several ? `Pay now for all ${lineCount} lines, 1, 4 or 12 draws each` : 'Pay now for 1, 4 or 12 draws')}
              ${
                several
                  ? methodOption('dd', 'fa-university', 'Direct Debit', 'One line of numbers per Direct Debit — pay for several lines by card', true)
                  : methodOption('dd', 'fa-university', 'Direct Debit', `Entered every draw until you cancel — ${formatPence(pence(200n))} a draw`)
              }
            </div>
          </div>
          ${
            opts.hasDirectDebit
              ? notice('fa-info-circle', 'You already pay by Direct Debit. Paying with the same numbers adds paid draws, which are used first while your Direct Debit pauses; different numbers add an extra entry alongside your existing ones.')
              : ''
          }

          <div id="pay-card" class="stack" ${method === 'card' ? '' : 'hidden'}>
            <div class="stack-10">
              <span class="field-label">${several ? 'How many draws for each line?' : 'How many draws?'}</span>
              ${segmentedDraws({ selected: blocks, price: total, legend: several ? 'How many draws for each line' : 'How many draws' })}
            </div>
            ${
              opts.hostedCardPage
                ? notice('fa-lock', "You'll enter your card details on <b>Elavon's secure payment page</b> next. They never pass through this site.")
                : // Sandbox only: practice fields with no name attribute, so nothing typed here is ever posted.
                  `${field({ label: 'Name on card', input: '<input id="pc-name" type="text" placeholder="Full name" autocomplete="off" data-required />' })}
            <div class="field-row">
              ${field({ label: 'Card number', input: '<input id="pc-num" type="text" placeholder="4242 4242 4242 4242" autocomplete="off" data-required />', className: 'grow-2' })}
              ${field({ label: 'Expiry', input: '<input id="pc-exp" type="text" placeholder="MM/YY" autocomplete="off" data-required />', className: 'grow-1' })}
              ${field({ label: 'CVC', input: '<input id="pc-cvc" type="text" placeholder="123" autocomplete="off" data-required />', className: 'grow-1' })}
            </div>
            ${notice('fa-flask', '<b>Sandbox payment</b> &mdash; any name, card number, expiry and CVC are accepted; this is a test transaction and no funds move.')}`
            }
          </div>

          <div id="pay-dd" class="stack" ${method === 'dd' ? '' : 'hidden'}>
            ${field({ label: 'Name of account holder', input: '<input id="dd-name" name="dd-name" type="text" placeholder="Full name" autocomplete="off" data-required />' })}
            <div class="field-grid">
              ${field({ label: 'Sort code', input: '<input id="dd-sort" name="dd-sort" type="text" placeholder="00-00-00" autocomplete="off" data-required />' })}
              ${field({ label: 'Account number', input: '<input id="dd-acc" name="dd-acc" type="text" placeholder="12345678" autocomplete="off" data-required />' })}
            </div>
            ${notice('fa-flask', '<b>Sandbox Direct Debit</b> &mdash; any name, sort code and account number are accepted; this is a test mandate and no funds move.')}
          </div>

          <button class="btn-primary tall" type="submit" id="pay-submit" ${method ? '' : 'hidden'}>
            <span id="submit-card-label" ${method === 'card' ? '' : 'hidden'}>Pay <span class="blocks-total">${total(blocks)}</span> &amp; enter</span>
            <span id="submit-dd-label" ${method === 'dd' ? '' : 'hidden'}>Set up Direct Debit</span>
            ${arrow}
          </button>
          <p class="pay-hint" id="pay-hint"></p>
        </form>
        <aside class="col-side panel-navy angle-c" data-reveal="right" data-delay="120" aria-label="Order summary">
          <h3 class="h-20">Order summary</h3>
          <div id="summary-none" ${method ? 'hidden' : ''}><p class="summary-muted">Choose how you'd like to pay.</p></div>
          <div id="summary-card" class="stack" ${method === 'card' ? '' : 'hidden'}>
            <div class="summary-row"><span id="summary-line">${summaryLine(blocks)}</span><span class="amount blocks-total">${total(blocks)}</span></div>
            ${jaggedDivider(true)}
            <div class="summary-total"><span>Total due today</span><span class="amount blocks-total" data-pulse>${total(blocks)}</span></div>
            <p class="summary-note">Your numbers go into this draw now and each following draw automatically until the draws you've paid for run out.</p>
          </div>
          <div id="summary-dd" class="stack" ${method === 'dd' ? '' : 'hidden'}>
            <div class="summary-row"><span>Each draw, from Draw ${openDraw.drawNumber}</span><span class="amount">${formatPence(pence(200n))}</span></div>
            ${jaggedDivider(true)}
            <div class="summary-total"><span>Due today</span><span class="amount" data-pulse>${formatPence(pence(0n))}</span></div>
            <p class="summary-note">Your numbers are entered into every draw until you cancel the Direct Debit from "My numbers".</p>
          </div>
        </aside>
      </div>
    `,
  });
}

// ── Payment / Direct Debit results (adopt the shell) ────────────────────────

function resultPanel(kind: 'success' | 'error' | 'muted', message: string, action?: { href: string; label: string }): string {
  const box =
    kind === 'success'
      ? `<div class="notice-success">${escapeHtml(message)}</div>`
      : kind === 'error'
        ? `<div class="notice-error" role="alert">${escapeHtml(message)}</div>`
        : `<p class="body-copy">${escapeHtml(message)}</p>`;
  return `<div class="panel narrow" data-reveal="left">${box}${action ? `<a class="btn-primary" href="${action.href}"><span>${action.label}</span>${arrow}</a>` : ''}</div>`;
}

export function purchaseReturnPage(opts: {
  member: ViewMember;
  openDraw?: OpenDraw | undefined;
  status: 'paid' | 'pending' | 'failed' | 'not_found';
  reason?: string;
  /** What was done with the payment (more weeks, or an extra entry; any Direct Debit pause). */
  message?: string;
}): string {
  const [heading, body] =
    opts.status === 'paid'
      ? ["You're in!", resultPanel('success', opts.message ?? 'Payment received — your entry is confirmed.', { href: '/account', label: 'View my numbers' })]
      : opts.status === 'pending'
        ? ['Payment processing', resultPanel('muted', 'This can take a moment. Refresh this page shortly, or check "My numbers" later.')]
        : opts.status === 'failed'
          ? ['Payment did not go through', resultPanel('error', opts.reason ?? 'The payment was not successful.', { href: '/draw', label: 'Try again' })]
          : ['Unknown payment session', resultPanel('muted', "We couldn't find that payment attempt.")];
  return layout({ title: 'Payment', eyebrow: 'Payment', heading, member: opts.member, body });
}

export function directDebitReturnPage(opts: {
  member: ViewMember;
  openDraw?: OpenDraw | undefined;
  status: 'active' | 'failed' | 'not_found';
  reason?: string;
  /** What the Direct Debit does (new numbers alongside, or after paid draws run out). */
  message?: string;
}): string {
  const [heading, body] =
    opts.status === 'active'
      ? ['Direct Debit set up', resultPanel('success', opts.message ?? 'Your Direct Debit is set up.', { href: '/account', label: 'View my numbers' })]
      : opts.status === 'failed'
        ? ['Direct Debit setup did not complete', resultPanel('error', opts.reason ?? 'The mandate setup was not successful.', { href: '/draw', label: 'Try again' })]
        : ['Unknown Direct Debit setup', resultPanel('muted', "We couldn't find that setup attempt.")];
  return layout({ title: 'Direct Debit', eyebrow: 'Direct Debit', heading, member: opts.member, body });
}

// ── My numbers / My details (adopt the shell) ───────────────────────────────

function smallBalls(selection: readonly number[]): string {
  return `<div class="balls">${selection.map((n) => `<span class="ball ball-sm">${n}</span>`).join('')}</div>`;
}

function entryHistoryRow(e: MyEntry): string {
  const matched = e.winningNumbers ? e.selection.filter((n) => e.winningNumbers!.includes(n)).length : undefined;
  const won = e.drawStatus === 'settled' && matched === 4;
  const result =
    e.drawStatus !== 'settled'
      ? `<span class="badge">Open</span>`
      : won
        ? `<span class="badge">${icon('fa-trophy')} Jackpot won</span>`
        : `${matched} matched`;
  return `<tr><td class="draw-no">${e.drawNumber}</td><td>${escapeHtml(formatDrawDate(e.drawDate))}</td><td>${smallBalls(e.selection)}</td><td>${result}</td></tr>`;
}

function flashNotice(flash: string | undefined): string {
  return flash ? notice('fa-check', escapeHtml(flash)) : '';
}

/**
 * One line on "My numbers", with a picker to change its numbers. The line
 * keeps its paid draws and any Direct Debit; draws already closed to entries
 * keep the old numbers.
 */
function lineWithChange(csrf: string, line: MemberLine, balls: (s: readonly number[]) => string): string {
  return `<div class="stack-10">
    ${balls(line.selection)}
    ${line.randomlyAllocated ? '<p class="small-hint">Picked for you at random, as no numbers were chosen.</p>' : ''}
    <details class="change-numbers">
      <summary class="btn-small">${icon('fa-pencil')} Change numbers</summary>
      <form method="post" action="/numbers/change" class="stack pick-line">
        ${csrfField(csrf)}
        <input type="hidden" name="prizeDrawNo" value="${line.prizeDrawNo}" />
        <input type="hidden" name="slot" value="${line.slot}" />
        <div class="pick-line-head">
          <b>New numbers</b>
          <div class="pick-line-tools">
            <span class="pick-count" aria-live="polite">${line.selection.length} of 4 selected</span>
            <button class="btn-small quick-pick" type="button">${icon('fa-random')} Pick for me</button>
          </div>
        </div>
        <div class="ball-grid" role="group" aria-label="New numbers">${ballPicker('numbers', line.selection)}</div>
        <p class="small-hint">Your paid draws and any Direct Debit stay with these numbers. Draws already closed to entries are drawn with your old numbers.</p>
        ${primaryButton('Save new numbers')}
      </form>
    </details>
  </div>`;
}


export function accountPage(opts: {
  member: ViewMember;
  openDraw?: OpenDraw | undefined;
  /** Every set of numbers the member holds — each is entered separately. */
  lines: readonly MemberLine[];
  entries: MyEntry[];
  directDebits: readonly DirectDebitStatus[];
  flash?: string;
  error?: string;
}): string {
  const { entries, lines, directDebits } = opts;
  const balls44 = (s: readonly number[]) => `<div class="balls">${s.map((n) => `<span class="ball ball-44">${n}</span>`).join('')}</div>`;
  const ddResult: Record<string, string> = {
    submitted: 'Sent to your bank',
    collected: 'Collected',
    failed: 'Not collected',
    rejected: 'Refused by your bank',
    refunded: 'Refunded',
  };
  const ddCollection = (c: DirectDebitStatus['history'][number]) =>
    `<tr><td>${escapeHtml(formatDrawDate(c.collectionDate))}${c.attempt > 1 ? ' (retry)' : ''}</td><td>${formatPence(pence(c.amountPence))}</td><td>${c.draws}</td><td>${escapeHtml(ddResult[c.status] ?? c.status)}</td></tr>`;
  const ddPanel =
    directDebits.length > 0
      ? `<div class="panel">
        <div class="panel-head"><h3>Direct Debit</h3><span class="badge">${directDebits.every((dd) => dd.confirmed) ? 'Active' : 'Awaiting your bank'}</span></div>
        <p class="small-hint">${formatPence(pence(200n))} a draw for each set of numbers below, collected monthly in advance early each month. We tell you the amount before each collection. Draws you have paid for by card are used first; the Direct Debit pauses for those and resumes after.</p>
        ${directDebits
          .map(
            (dd) => `<div class="stack-10">
          ${dd.selection ? balls44(dd.selection) : ''}
          <p class="small-hint">Set up ${escapeHtml(formatLondon(dd.since))}.${
            dd.confirmed ? '' : ' Waiting for your bank to confirm it &mdash; these numbers are entered by Direct Debit once it has.'
          }</p>
          ${
            dd.next
              ? `<p class="small-hint"><b>Next collection:</b> ${formatPence(pence(dd.next.amountPence))} on or just after ${escapeHtml(formatDrawDate(dd.next.collectionDate))}, for ${dd.next.draws} draw${dd.next.draws === 1 ? '' : 's'}${dd.next.attempt > 1 ? ' (a second try after the last one failed)' : ''}.</p>`
              : ''
          }
          ${
            dd.history.length > 0
              ? `<div class="table-wrap"><table class="history"><thead><tr><th>Collection</th><th>Amount</th><th>Draws</th><th>Result</th></tr></thead><tbody>${dd.history.slice(0, 6).map(ddCollection).join('')}</tbody></table></div>`
              : ''
          }
          <form method="post" action="/direct-debit/cancel" data-confirm="Cancel this Direct Debit? These numbers will no longer be entered by Direct Debit.">
            ${csrfField(opts.member.csrf)}
            <input type="hidden" name="paymentMethodId" value="${escapeHtml(dd.id)}" />
            <button class="btn-secondary small" type="submit">Cancel this Direct Debit</button>
          </form>
        </div>`,
          )
          .join(jaggedDivider())}
      </div>`
      : '';
  return layout({
    title: 'My numbers',
    eyebrow: 'My account',
    heading: 'My numbers',
    lede: "Your numbers, upcoming entries and how they've fared.",
    member: opts.member,
    body: `
      <div class="stack">
        ${flashNotice(opts.flash)}
        ${errorNotice(opts.error)}
        <div class="cols">
          <div class="panel" data-reveal="left">
            <div class="panel-head"><h3>Currently entered</h3>${lines.length > 0 ? `<span class="badge">${icon('fa-check')} Entered</span>` : ''}</div>
            ${lines.length > 0 ? lines.map((line) => lineWithChange(opts.member.csrf, line, balls44)).join(jaggedDivider()) : `<p class="body-copy">No standing numbers yet.</p>`}
            <a class="btn-secondary small" href="/draw">Add draws or numbers</a>
          </div>
          ${ddPanel}
        </div>
        <div class="panel panel-white" data-reveal="up" data-delay="120">
          <h3>Entry history</h3>
          ${
            entries.length === 0
              ? `<p class="body-copy">No entries yet &mdash; <a href="/draw">enter the current draw</a>.</p>`
              : `<div class="table-wrap"><table class="history"><thead><tr><th>Draw</th><th>Date</th><th>Numbers</th><th>Result</th></tr></thead><tbody>${entries.map(entryHistoryRow).join('\n')}</tbody></table></div>`
          }
        </div>
      </div>
    `,
  });
}

export function detailsPage(opts: { member: ViewMember; openDraw?: OpenDraw | undefined; details: MemberDetails; flash?: string }): string {
  const { details } = opts;
  const contactOption = (value: string, label: string) =>
    `<label><input type="radio" name="preferredContact" value="${value}" ${details.preferredContact === value ? 'checked' : ''} /> ${label}</label>`;
  const text = (id: string, label: string, value: string | null, type = 'text') =>
    field({ label, input: `<input id="${id}" name="${id}" type="${type}" value="${escapeHtml(value ?? '')}" />` });
  return layout({
    title: 'My details',
    eyebrow: 'My account',
    heading: 'My details',
    lede: "Keep this up to date &mdash; it's how we reach you if your numbers come up.",
    member: opts.member,
    body: `
      <div class="stack">
        ${flashNotice(opts.flash)}
        <div class="cols">
          <div class="panel" data-reveal="left">
            <h3>Contact</h3>
            <div class="field-pair">
              ${field({ label: 'Forename', input: `<input type="text" value="${escapeHtml(details.forename ?? '')}" disabled />` })}
              ${field({ label: 'Surname', input: `<input type="text" value="${escapeHtml(details.surname ?? '')}" disabled />` })}
            </div>
            ${field({ label: 'Email', input: `<input type="email" value="${escapeHtml(details.email ?? '')}" disabled />` })}
            <form method="post" action="/details" class="stack">
              ${csrfField(opts.member.csrf)}
              ${text('telephone', 'Mobile / telephone', details.telephone, 'tel')}
              ${text('address1', 'Address line 1', details.address1)}
              ${text('address2', 'Address line 2', details.address2)}
              <div class="field-pair">
                ${text('address3', 'Town', details.address3)}
                ${text('county', 'County', details.county)}
              </div>
              ${text('postCode', 'Postcode', details.postCode)}
              <span class="field-label">Notify me by</span>
              <div class="radio-row">
                ${contactOption('email', 'Email')}
                ${contactOption('phone', 'Phone')}
                ${contactOption('post', 'Post')}
              </div>
              ${primaryButton('Save changes')}
            </form>
          </div>
          <div class="panel panel-white" data-reveal="right" data-delay="120">
            <h3>Prize payout account</h3>
            ${notice('fa-info-circle', 'Online payout account management is coming soon. Winnings are currently arranged directly with QOSFC.')}
          </div>
        </div>
      </div>
    `,
  });
}

// ── Past draws ──────────────────────────────────────────────────────────────

export function pastDrawsPage(opts: { member?: ViewMember; openDraw?: OpenDraw | undefined; draws: SettledDraw[] }): string {
  const [latest] = opts.draws;
  const balls = (d: SettledDraw, cls: string, data = '') => d.winningNumbers.map((n) => `<span class="ball ${cls}"${data}>${n}</span>`).join('');

  const latestCard = latest
    ? (() => {
        const paid = BigInt(latest.jackpotPaidPence ?? '0');
        const rolled = BigInt(latest.rolloverOutPence ?? '0');
        const winners = latest.winnersCount ?? 0;
        return `<div class="latest-card" data-reveal="left">
          <div class="stack-10">
            <span class="stat-label">Latest · Draw No. ${latest.drawNumber} · ${escapeHtml(formatDrawDate(latest.drawDate))}</span>
            <div class="balls">${balls(latest, 'ball-result', ' data-ball')}</div>
          </div>
          <div class="skew-rule" aria-hidden="true"></div>
          <div class="stat"><span class="stat-label">Jackpot</span><span class="stat-value" data-pulse>${formatMoney(paid + rolled)}</span></div>
          ${
            winners > 0
              ? `<div class="stat"><span class="stat-label">Winners</span><span class="stat-value">${winners}</span></div>`
              : `<div class="stat"><span class="stat-label">Rolled over</span><span class="stat-value">${formatMoney(rolled)}</span></div>`
          }
        </div>`;
      })()
    : '';

  const head = ['Draw', 'Date', 'Winning numbers', 'Jackpot', 'Winners', 'Rollover']
    .map((h, i) => `<span class="th${i === 0 ? ' first' : i === 5 ? ' last' : ''}">${h}</span>`)
    .join('');
  const rows = opts.draws
    .map(
      (d) => `<span class="first draw-no">${d.drawNumber}</span>
        <span>${escapeHtml(formatDrawDate(d.drawDate))}</span>
        <span class="balls-cell">${balls(d, 'ball-sm')}</span>
        <span class="money">${moneyOrDash(d.jackpotPaidPence)}</span>
        <span>${d.winnersCount ?? 0}</span>
        <span class="last rollover">${moneyOrDash(d.rolloverOutPence)}</span>`,
    )
    .join('');
  const cards = opts.draws
    .map(
      (d) => `<div class="result-card">
        <div class="result-card-head"><b>Draw ${d.drawNumber}</b><span>${escapeHtml(formatDrawDate(d.drawDate))}</span></div>
        <div class="balls">${balls(d, 'ball-card')}</div>
        <div class="result-card-stats">
          <span>Jackpot<b>${moneyOrDash(d.jackpotPaidPence)}</b></span>
          <span>Winners<b>${d.winnersCount ?? 0}</b></span>
          <span class="rollover">Rollover<b>${moneyOrDash(d.rolloverOutPence)}</b></span>
        </div>
      </div>`,
    )
    .join('');

  return layout({
    title: 'Past draws',
    eyebrow: 'Results',
    heading: 'Past draws',
    lede: 'Winning numbers, jackpots and winners from every settled draw.',
    ...(opts.member ? { member: opts.member } : {}),
    body:
      opts.draws.length === 0
        ? `<div class="panel narrow" data-reveal="left"><p class="body-copy">No draws have been settled yet.</p></div>`
        : `<div class="stack">
        ${latestCard}
        <div class="results-table" data-reveal="up" data-delay="120"><div class="results-grid">${head}${rows}</div></div>
        <div class="results-cards" data-reveal="up" data-delay="120">${cards}</div>
      </div>`,
  });
}
