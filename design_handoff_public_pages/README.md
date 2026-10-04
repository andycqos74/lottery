# Handoff: Doonhamers Draw — public pages redesign

Suggested location in the repo: `docs/design_handoff_public_pages/`

## Overview
A redesign of the member-facing (public) pages of the QOSFC Lottery portal (`andycqos74/lottery`, `apps/api`), plus a **new landing page**. The aim is a professional, modern look in the Queen of the South FC visual identity, with distinctive irregular/jagged lines, subtle attention animation on jackpots and winning numbers, and slide-in content reveals on scroll.

Pages covered:
1. **Landing** (new) — `/`
2. **Sign up** — `registerPage()`
3. **Log in** — `loginPage()`
4. **Forgotten password** — `forgotPasswordPage()`
5. **Reset password** — `resetPasswordPage()`
6. **Past draws** — `pastDrawsPage()`
7. **Current draw (pick numbers)** — `drawPage()`
8. **Payment** — `paymentPage()`

Out of scope (unchanged for now, but should adopt the new shell): `accountPage`, `detailsPage`, `purchaseReturnPage`, `directDebitReturnPage`.

## About the design files
The files in `designs/` are **design references built in HTML**: prototypes that show the intended look and behaviour. They are not production code to copy. Recreate them in the existing environment: **server-rendered HTML template strings in `apps/api/src/views.ts`**, with one shared `STYLE` string and small inline `<script>` blocks. Keep that approach. Don't introduce a frontend framework.

To view a prototype, open `designs/Landing Page v2.dc.html` or `designs/Public Pages v2.dc.html` in a browser from this folder; `support.js` and `_ds/` must sit next to them. In the Public Pages prototype, the bar at the very top ("PAGE: Sign up / Log in / …") is a review-only page switcher. **Do not build it.**

`designs/reference/Current - Sign up.dc.html` is a faithful recreation of the *current* UI, for before/after comparison.

## Fidelity
**High fidelity.** Colours, type, spacing, copy and interactions are final. Recreate pixel-accurately. The prototypes use inline styles; in `views.ts`, turn them into classes in the replacement `STYLE` string.

---

## Global shell (all pages)

### Fonts
Replace the current Google Fonts link (Big Shoulders Display / Figtree / Space Mono) with:
```
https://fonts.googleapis.com/css2?family=Merriweather+Sans:wght@400;700;800&family=Open+Sans:wght@300;400;600;700;800&family=Play:wght@400;700&display=swap
```
- **Display / headings:** `"Merriweather Sans", sans-serif`, weight 800
- **Body / UI:** `"Open Sans", sans-serif`
- **Numbers / accents** (balls, countdown, draw numbers, eyebrows, prices): `"Play", sans-serif`, weight 700

Icons: **Font Awesome 4.7** from `https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css`. Used: `fa-user`, `fa-arrow-right`, `fa-random`, `fa-angle-double-right`, `fa-heart`, `fa-ticket`, `fa-trophy`, `fa-envelope`, `fa-flask`, `fa-credit-card`, `fa-university`. **Remove every emoji** from the current views (🏟️ 🎟️ 🏆 ✅ ✉️ 🎲 🔒 🧪 ℹ️) and use the FA icons or plain text instead.

Drop the dark-mode variables from the current `STYLE`. The new design is light-only.

### Base
- `body { margin:0; background:#fff; font-family:"Open Sans"; color:#333 }`, `* { box-sizing:border-box }`
- `a { color:#094582 } a:hover { color:#3068a7 }`
- **Corners are square** everywhere (panels, buttons, segmented controls, menus). Exceptions: inputs use `border-radius:4px`; balls and the profile button are circles.
- No shadows. No gradients.

### Nav bar (replaces the current left sidebar)
- The `.app` 250px sidebar grid is removed. The page is one column: nav → page header → slanted band → main → footer.
- `<nav>`: height 76px, **background sky `#009fff`, no border**, padding `0 clamp(16px,4vw,48px)`, flex, `justify-content:space-between`, gap 12px, `position:relative; z-index:5`. It sits directly on the ice header with no divider.
- **Left: brand link** (to `/`). Flex, gap `clamp(8px,2vw,14px)`:
  - Crest `qos-crest.png`, `clamp(40px,10vw,52px)` square.
  - Two stacked lines (gap 2px):
    - "Queen of the South FC": Open Sans 700, `clamp(9px,2.6vw,11px)`, letter-spacing `clamp(1px,.5vw,2px)`, uppercase, **`#e1e8f9`** (ice-2), nowrap.
    - "The Doonhamers Draw": Merriweather Sans 800, `clamp(15px,4.2vw,20px)`, **`#f2f8fe`** (ice), nowrap.
- **Right** (flex, gap 8px):
  - **Menu button**: height 44px, min-width 44px, transparent, no border, **`#f2f8fe`** text, Open Sans 700 15px, letter-spacing 1px, uppercase. Shows "MENU ☰" (the word "Menu" is hidden below 560px viewport width; just ☰ at 22px). When open the glyph becomes "×". **Hover colour navy `#094582`.**
  - **Profile link**: a 44×44 circle, background `#094582`, white `fa-user` at 20px; hover `opacity:.7`. Links to `/account` when logged in and `/login` when logged out.
- **Menu dropdown** (toggled by the Menu button): `position:absolute; top:76px; right:clamp(0px,4vw,48px); width:min(300px,100%)`, background `#094582`, padding 12px 0. Items are links with padding 12px 24px, white, Open Sans 700 14px, letter-spacing 1px, uppercase, hover background `#009fff`.
  - Logged out: Home, Current draw, Results, How to play, Good causes, Log in / Sign up
  - Logged in: Home, Current draw, My numbers, My details, Results, Log out (a POST form with CSRF, like today)
  - Close on outside click and on Escape. Give it `aria-expanded`/`aria-controls`.

### Inner page header (every page except landing)
- `<header>`: background `#f2f8fe`, `display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr)); overflow:hidden`.
- **Left cell** (padding `clamp(32px,7vw,56px) clamp(16px,4vw,32px) clamp(36px,8vw,72px) clamp(16px,4vw,48px)`, flex column, gap 12px, centred vertically):
  - Eyebrow: Play 700 15px, letter-spacing 1.5px, uppercase, `#3068a7`
  - H1: Merriweather Sans 800, `clamp(34px,4.5vw,56px)`, line-height 1.1, `#094582`
  - Lede: 17px / 1.6, `#666`, max-width 56ch, `text-wrap:pretty`
- **Right cell: solid-colour block, no image.** `position:relative; min-height:clamp(56px,22vw,240px)`. Stack of absolutely positioned layers (`inset:0`):
  1. `#009fff`, `clip-path:polygon(14% 0,100% 0,100% 100%,0 100%,9% 70%,4% 46%,12% 22%)`
  2. `#094582`, `clip-path:polygon(19% 0,100% 0,100% 100%,5% 100%,14% 70%,9% 46%,17% 22%)`
  3. `#3068a7`, `clip-path:polygon(62% 0,100% 0,100% 100%,44% 100%,55% 58%,50% 34%)`
  4. SVG (viewBox 0 0 100 100, `preserveAspectRatio="none"`, 100%×100%) with polyline `70,0 58,34 63,58 52,100`, stroke `#009fff`, width 3, `vector-effect:non-scaling-stroke`
  - On mobile it stacks under the title as a thin coloured strip.

Per-page header copy (eyebrow / H1 / lede):
| Page | Eyebrow | H1 | Lede |
|---|---|---|---|
| Sign up | Sign up | Join the draw | Pick 4 numbers from 1–20, every week, for £2. Every entry supports Queen of the South FC — match all four and share the jackpot. |
| Log in | Log in | Welcome back | Log in to check this week's numbers, top up your entries, or see what you've won. |
| Forgotten | Log in | Forgotten password | Enter the email address on your account and we'll send you a link to reset your password. |
| Reset | Log in | Choose a new password | Use at least 10 characters. |
| Past draws | Results | Past draws | Winning numbers, jackpots and winners from every settled draw. |
| Current draw | `Draw No. {n} · {drawWhen}` | Current draw (or `drawHeading(draw)`) | `Drawn {drawWhen} — entries close {closeAt}. Pick 4 numbers from 1 to 20, or let us pick for you.` |
| Payment | `Draw No. {n}` | Pay for your entries | £2.00 buys one entry into one draw. Pay by card for a set number of draws, or by Direct Debit to stay entered every draw. |

### Slanted band (under every header)
A 28px-tall element with `margin-top:-14px; position:relative; z-index:3`, containing two absolutely positioned bars skewed `skewY(-1deg)`: the top part `#009fff` (`inset:0 0 10px 0`) and the bottom part `#094582` (`inset:10px 0 0 0`).

### Main container
`max-width:1140px; margin:0 auto; padding:clamp(32px,6vw,64px) clamp(16px,3vw,24px) clamp(64px,10vw,96px)`.

### Footer
Background `#094582`, colour `#d3e4f5`, padding `40px clamp(16px,4vw,48px) 32px`, flex-wrap, gap 20–24px, 13px. Irregular top edge: `clip-path:polygon(0 12px,30% 0,62% 14px,100% 2px,100% 100%,0 100%)`. Contents: crest 40–44px, the text "The Doonhamers Draw · Queen of the South FC · Palmerston Park, Dumfries", and right-aligned white links Rules, Privacy, Play responsibly, Contact (no underline).

### Shared components
- **Panel (light):** background `#f2f8fe`, `1px solid #c9d7e4`, padding `clamp(20px,5vw,32px)` (forms) or `clamp(18px,4.5vw,28px)` (draw/pay), flex column, gap 18–22px.
- **Panel (navy, angled):** background `#094582`, white text, slightly irregular edges via `clip-path:polygon(0 0,100% 2%,98% 100%,1% 98%)` (or `100% 3% / 98% 100% / 2% 97%`). Secondary text `#d3e4f5`; labels `#9cc9f0`.
- **Field:** `<label>` is a flex column with gap 6px, Open Sans 700 13px, `#666`; the input is height 48px, padding 0 14px, `1px solid #c9d7e4`, radius 4px, 15px, white background. Hints are 12px 400 `#6c757d`. Focus: `outline:2px solid #009fff; outline-offset:2px`.
- **Primary button:** height 54–56px, full width in forms, background `#094582`, white, Open Sans 700 16px, padding 0 22px, flex `space-between`, with the label on the left and `fa-arrow-right` on the right. Hover `#3068a7`. Disabled/incomplete state: background `#8fa6c1`.
- **Secondary button:** white or transparent background, `2px solid #094582` (or `1px solid #c9d7e4` for small ones), `#094582` text, 700.
- **Segmented control (draw count):** a grid of 3 equal columns inside `1px solid #c9d7e4`. Each option is 48–56px tall; unselected `#fff` / `#094582` text, selected `#094582` / white. Label 700 14px, with the price underneath in Play 13px.
- **Picker ball (button):** circle, `aspect-ratio:1`, max 48–60px, `2px solid`. Unselected: white background, `#094582` text, `#c9d7e4` border. Selected: `#094582` fill, white text, `#094582` border. Play 700 17–21px. `transition:all .2s ease`.
- **Result ball:** circle, 56–76px (`clamp(56px,16vw,76px)` on landing, `clamp(52px,14vw,68px)` on past draws), Play 700 `clamp(24px,7vw,34px)`. On the navy band: white fill with navy text. On white: navy fill with white text.
- **Small table ball:** 34px (40px in the mobile cards), `2px solid #094582` outline, navy text, Play 700 14–16px.
- **Notice:** background `#f2f8fe`, `1px solid #b7c7f1`, padding 14px 16px, 14px / 1.5, `#094582`, with an FA icon first (flex, gap 12px). Use it for the sandbox banners and the "reset link sent" notice.
- **Stat label:** Open Sans 700 12–13px, letter-spacing 1.5–2px, uppercase, `#6c757d`. **Stat value:** Merriweather Sans 800.
- **Jagged divider (inside panels):** SVG polyline, stroke `#c9d7e4` (or `#009fff` on navy), width 2, `preserveAspectRatio="none"`, `vector-effect:non-scaling-stroke`, e.g. `0,5 50,2 110,8 170,3 240,7 300,2 360,7 400,4` on viewBox `0 0 400 10`.

---

## Screens

### 1. Landing (`/`, new) — `designs/Landing Page v2.dc.html`
The sections run full-bleed. Content blocks marked *centred* are capped at `max-width:1280px; margin:0 auto`.

1. **Nav** (as above).
2. **Hero** (background `#f2f8fe`, grid `repeat(auto-fit,minmax(min(100%,440px),1fr))`, min-height 560px):
   - Left (padding `clamp(32px,7vw,56px) clamp(16px,4vw,32px) clamp(48px,9vw,80px) clamp(16px,4vw,48px)`, gap 20px):
     - Eyebrow `Draw No. 143 · Saturday 10 October · 7pm`: Play 700 `clamp(13px,3.4vw,16px)`, `#3068a7`, uppercase
     - H1 "Estimated jackpot": Merriweather 800 `clamp(22px,5.5vw,30px)`, navy
     - **Jackpot figure** `£1,860`: Merriweather 800 `clamp(72px,11vw,140px)`, line-height .95, letter-spacing −3px, navy. Behind it is a sky highlighter bar: absolute, `left:-12px; right:-24px; top:58%; height:44px; background:#009fff; opacity:.25; clip-path:polygon(0 30%,100% 0,97% 100%,2% 80%)`.
     - **Countdown**: 4 boxes (Days / Hours / Mins / Secs), each `flex:1 1 0; min-width:60px; max-width:84px`, white, `1px solid #c9d7e4`, padding 10px 0. Value Play 700 `clamp(24px,7vw,32px)` navy, zero-padded; label 11px, letter-spacing 2px, uppercase, `#6c757d`. Counts down to `draw.drawAt` and ticks every second.
     - CTAs: "Play this week →" (primary, anchors to `#easy-entry`) and "How it works" (secondary, anchors to `#how-to-play`).
   - Right: photo, `min-height:clamp(220px,45vw,380px)`. A sky `#009fff` layer with `clip-path:polygon(14% 0,100% 0,100% 100%,0 100%,9% 70%,4% 46%,12% 22%)`, then the photo on top with `clip-path:polygon(17% 0,100% 0,100% 100%,3% 100%,12% 70%,7% 46%,15% 22%)`, `object-fit:cover`. Photo: `assets/landing-hero.webp`.
3. **Last-draw band**, overlapping the hero by `margin-top:-40px`, z-index 3:
   - A sky backing layer (`inset:-14px 0 14px 0`, `skewY(-1.6deg)`) behind a navy layer (`skewY(-1.6deg)`, padding `clamp(28px,6vw,40px) clamp(16px,4vw,48px)`). The content inside is counter-skewed `skewY(1.6deg)`.
   - Content (flex-wrap, gap `20px clamp(24px,5vw,48px)`, white): "Last draw" (Merriweather 800 26px) with `No. 142 · Sat 3 Oct` under it (Play 14px `#9cc9f0`); 4 result balls (white); Jackpot `£1,240`; Winners `2` with "£620 each" (15px 600 `#d3e4f5`). Labels are 12px uppercase `#9cc9f0`; values are Merriweather 800 `clamp(32px,9vw,44px)`. On ≥900px the Jackpot block is pushed right with `margin-left:auto`.
   - Data: the latest `listSettledDraws(pool, 1)` row. Per-winner amount = `jackpotPaidPence / winnersCount`. If `winnersCount === 0`, show "Rolled over" plus `rolloverOutPence` in place of winners.
4. **Easy entry** (`id="easy-entry"`, *centred*, padding `clamp(64px,12vw,110px) clamp(16px,4vw,48px) clamp(56px,10vw,96px)`, flex-wrap, gap `48px 64px`):
   - Intro (`flex:1 1 280px`): eyebrow "Easy entry" (Play 700 15px sky `#009fff`, uppercase, letter-spacing 2px); H2 `Pick your four for Draw {n}` (Merriweather 800 `clamp(28px,7vw,40px)`); copy "Tap four numbers or use Lucky Dip. Choose how many draws, then pay by card or Direct Debit on the next step." (16px / 1.6 `#666`).
   - Picker panel (`flex:3 1 min(100%,480px)`, light panel):
     - **Ball grid: exactly 10 columns (2 rows) when the panel's inner width is at least 10×48 + 9×12 + 40px, otherwise exactly 5 columns (4 rows), max-width 360px, centred.** Never another column count. Gap 12px. Use a container query (`@container (min-width: 628px)`) or a ResizeObserver.
     - Divider: 2px `#c9d7e4`.
     - Controls row (flex-wrap, gap 16px): "{k} of 4 selected" (700 15px); a "Lucky Dip" button (`fa-random`); the 1 / 4 / 12 draws segmented control; and the submit button (`flex:1 1 240px`, `margin-left:auto`). Until 4 numbers are picked the submit reads "Pick {n} more number(s)" with background `#8fa6c1`. After that it reads "Continue to payment · £{2×draws}.00" in navy.
   - **Wire as a real form:** `<form method="get" action="/draw/pay">` with checkboxes `name="line1"` (same as `ballGrid()` today) and `name="blocks"`. Logged-out users are sent to `/register` (or `/login`) and then back to `/draw/pay` with their picks kept.
5. **How to play** (`id="how-to-play"`, background `#f2f8fe`, padding `clamp(56px,10vw,96px) clamp(16px,4vw,48px)`). The top edge is a jagged white SVG polygon: viewBox `0 0 1280 40`, points `0,0 1280,0 1280,14 1130,30 980,8 820,26 650,6 500,32 330,10 170,28 0,12`, fill `#fff`, 100% width.
   - H2 "How to play": Merriweather 800 `clamp(28px,7vw,40px)`, navy, margin-bottom `clamp(32px,6vw,56px)`.
   - Grid `repeat(auto-fit,minmax(min(100%,220px),1fr))`, gap `40px 36px`. Each step has `padding-left:28px` and a 2px sky rule on its left edge skewed `skewX(-12deg)` (absolute, full height).
   - **Step number:** an 84×84 navy box with white Play 700 30px text and `clip-path:polygon(0 8%,100% 0,94% 100%,4% 92%)`. Then the title (Merriweather 800 22px navy) and body (15px / 1.6 `#666`).
   - Copy:
     - 01 Create an account: "Register with your name, email address and a password."
     - 02 Pick 4 numbers: "Choose 4 numbers from 1 to 20, or use Lucky Dip. Add more lines if you like."
     - 03 Pay £2 per draw: "Pay by card for 1, 4 or 12 draws, or by Direct Debit to stay entered every draw."
     - 04 Watch the draw: "Match all 4 to share the jackpot. If nobody does, it rolls over to the next draw."
6. **Totals** (*centred*, white, padding `clamp(56px,10vw,96px) clamp(16px,4vw,48px)`, grid `repeat(auto-fit,minmax(min(100%,380px),1fr))`, gap `56px 64px`):
   - "Prize money paid out" with value (Merriweather 800 `clamp(60px,8vw,100px)` navy), a jagged sky underline (SVG polyline `0,12 50,4 110,14 170,3 230,13 290,5 360,10`, stroke 6, bevel join, max-width 360px), and "to winners since the draw began".
   - "Contributed to charity" with value, underline `0,8 60,14 120,4 180,13 240,3 300,12 360,6`, and "for the Queen of the South Community Trust".
   - Full-width split bar: 14px tall, three segments skewed `skewX(-20deg)` with a 4px gap: 50% `#094582`, 40% `#009fff`, 10% `#c9d7e4`. Legend below (flex-wrap, gap `8px 24px`, 600 14px) with 14px skewed swatches: "50% Prize fund", "40% Community Trust", "10% Running costs".
   - **Data needs new queries.** Prize paid = `SUM(jackpot_paid_pence)::bigint` over settled draws. Charity = the 40% allocation from the ledger (`0005_ledger_prizes.sql`). Confirm the split config (`config_version`). The README says "50/40/10" without naming the shares, so the business owner must confirm the order (prize / charity / costs) before shipping. If the rule is undecided, follow the repo convention: use `unresolvedGap`, or hide the section rather than invent figures.
7. **Community** (background `#f2f8fe`, padding `clamp(64px,12vw,110px) clamp(16px,4vw,48px) clamp(72px,12vw,120px)`, jagged white top edge with points `0,0 1280,0 1280,22 1120,6 960,30 800,10 640,34 480,8 320,28 160,12 0,26`). Grid `repeat(auto-fit,minmax(min(100%,400px),1fr))`, gap `clamp(40px,7vw,56px)`:
   - Image block: height `clamp(220px,50vw,320px)`, margin-right 14px. A sky offset layer (`inset:14px -14px -14px 14px`) sits behind the photo. Both use `clip-path:polygon(0 4%,100% 0,97% 100%,3% 94%)`. Photo: `assets/community-trust.webp`.
   - Text: eyebrow "Good causes"; H3 "Playing supports the community" (Merriweather 800 `clamp(26px,6.5vw,36px)` navy); body "Forty pence in every pound goes to the Queen of the South Community Trust. Every line you enter helps fund its work across Dumfries and Galloway."; link "About the Trust »".
8. **Footer.**

### 2. Sign up
Grid `repeat(auto-fit,minmax(min(100%,380px),1fr))`, gap 24px.
- Light panel: H2 "Create your account" (Merriweather 800 24px); a Forename / Surname row (`repeat(auto-fit,minmax(150px,1fr))`); Email address; Password with the hint "At least 10 characters."; primary button "Create my account →"; "Already a member? **Log in**". Field names, `required`, `minlength="10"` and `autocomplete` stay exactly as today.
- Navy angled panel: H2 "Why join the Draw". Three rows, each with a 44px sky icon tile (`clip-path:polygon(0 6%,100% 0,94% 100%,4% 94%)`, midnight `#00091c` icon) and 15px / 1.6 text in `#e6f0fa`:
  - `fa-heart`: "40p in every £1 goes to the Queen of the South Community Trust." (replaces the old "100% of profit…" line; confirm the wording with the club)
  - `fa-ticket`: "Entries are £2 each. Pay per draw, or in blocks of 4 or 12 to skip the top-up."
  - `fa-trophy`: "Match all 4 of 4 numbers to share that week's jackpot. No match, no worries — it rolls into next week's."
- Error: a red notice at the top of the form panel (background `#fdecea`, colour `#b3261e`, border `#f3c1bd`, square). Keep the existing messages.

### 3–5. Log in / Forgotten password / Reset password
One light panel, max-width 460px.
- Log in: Email, Password, "Log in →", "Forgotten your password?" (centred 600 14px), a jagged divider, then "New to the Draw? **Create an account**". The `notice` prop is shown as a Notice with `fa-check`.
- Forgotten: Email and "Send reset link →". When sent, the form is replaced by a Notice (`fa-envelope`) reading "If that email address is registered, a reset link is on its way — it expires in an hour." Then "Back to log in".
- Reset: New password (hint "At least 10 characters.") and "Reset password →". Keep the hidden `token`.

### 6. Past draws
- **Latest card** (white, `1px solid #c9d7e4`, flex-wrap, gap `20px clamp(20px,5vw,32px)`): label `Latest · Draw No. {n} · {date}`, 4 navy result balls, a skewed sky rule (3px, `skewX(-16deg)`), Jackpot and Winners.
- **≥700px: table.** A white container with `overflow-x:auto; overflow-y:hidden` and a 6-column CSS grid `90px 140px minmax(220px,1fr) 120px 100px 120px` (min-width 720px). The header row is navy with white 12px 700 uppercase text (letter-spacing 1.5px, padding 14px 12–20px). Columns: Draw (Play 700 navy), Date, Winning numbers (small table balls), Jackpot (700), Winners, Rollover (600 `#3068a7`). Rows have a `1px solid #efefef` bottom border.
- **<700px: card list** instead of the table. Each card is white with a steel border and padding 16px: "Draw {n}" with the date right-aligned, 4 balls (40px), then a 3-column row with Jackpot, Winners and Rollover (label 13px `#6c757d`, value 700 15px).
- Show "—" for null pence values. Format money with `formatPence`.

### 7. Current draw (pick numbers)
Flex-wrap, gap 24px.
- Main light panel (`flex:2 1 min(100%,540px)`): H2 `Your numbers for Draw {n}`. One block per line (`linePicker`):
  - Header row: "Line {i}" (700 15px navy) and right-aligned "{k} of 4 selected" (Play 13px `#666`), a "**Pick for me**" button (`fa-random`, 34px, white, steel border, nowrap) and, for lines after the first, "Remove".
  - Ball grid: **10 columns at viewport ≥720px, otherwise 5**, columns `minmax(0,48px)`, gap 8px.
  - Each line block ends with a `1px solid #efefef` bottom border.
  - Actions: "+ Add another line" (secondary; hidden at `MAX_LINES_PER_PURCHASE`) and "Continue to payment →" (primary).
  - Hints (13px `#6c757d`): "Each line is a separate entry in every draw it's paid for. Use different numbers on each line — up to {MAX} lines in one payment."
- Side column (`flex:1 1 280px`):
  - Navy angled panel: "Estimated jackpot" with the value (Merriweather 800 64px, pulse animation) and a jagged sky underline.
  - White stats panel: Ticket price £2.00 and Entries this week `{stats.entriesCount}`, with the hint "Pay by Direct Debit, or buy 4 or 12 draws by card, and your numbers stay entered automatically — no need to pick again next week."
  - If `currentEntry` exists, keep the "Ticket stub" card, restyled as a white panel with the stub number in Play 700 24px navy and an "Entered" badge (`#094582` on `#e1e8f9`, square).
- Keep the existing inline script logic (max 4 per line, quick pick, remove, add line). Only the markup and classes change.

### 8. Payment
Flex-wrap, gap 24px.
- Main light panel: "Your numbers for Draw {n}". Each line is a row of 44px navy balls; the "Line {i}" label is shown **only when there are several lines**. Then "Change numbers or add another line".
- "How would you like to pay?" as two method cards (`repeat(auto-fit,minmax(220px,1fr))`, gap 10px). Each card is a `<label>` wrapping a radio with padding 16px, an FA icon (`fa-credit-card` / `fa-university`, 20px navy), a 700 15px navy title and a 13px `#666` detail line. Selected: `2px solid #094582`, background `#f2f8fe`. Unselected: `2px solid #c9d7e4`, white. The Direct Debit card is disabled when there are several lines (opacity .55), as today.
- Card: "How many draws?" segmented control (1 / 4 / 12, price = 2 × draws × lines). Then Name on card, and a row with Card number (`flex:2 1 220px`), Expiry (`flex:1 1 100px`) and CVC (`flex:1 1 100px`). Then the sandbox Notice (`fa-flask`), or the Elavon hosted-page notice (`fa-lock`) when `hostedCardPage`.
- Direct Debit: Name of account holder, then Sort code and Account number (`repeat(auto-fit,minmax(min(100%,160px),1fr))`), then the sandbox Notice.
- Submit (primary): "Pay £{total} & enter" or "Set up Direct Debit".
- Order summary (navy angled panel, `flex:1 1 280px`): the line description and amount (Play 700), a jagged sky divider, then "Total due today" / "Due today" with the amount (Merriweather 800 30px, pulse), and the existing explanatory note.
- Keep all existing form names, hidden inputs, CSRF and the `choose()` script behaviour.

---

## Interactions & animation
All motion must be wrapped in `@media (prefers-reduced-motion: no-preference)`.
- **Scroll reveal:** elements marked `data-reveal="left|right|up"` start at `opacity:0` with `translateX(-90px)` / `translateX(90px)` / `translateY(50px)` and animate to rest over `opacity .8s ease, transform .9s cubic-bezier(.2,.7,.2,1)`. Optional `data-delay` (ms) staggers siblings: how-to-play steps use 0 / 140 / 280 / 420ms; right-hand panels use 120–150ms.
  - **Only pre-hide elements that start below the fold**, so content is never invisible without JS. Use IntersectionObserver (threshold .15) and show the element when it enters the viewport. On the landing page, re-hide elements when they leave below the viewport so the effect replays.
  - Inner pages: the same slide-in plays once on page load for the header and panels.
- **Jackpot pulse:** `data-pulse` elements (the current jackpot, last jackpot, payment total) scale `1 → 1.035 → 1` over 2.8s, ease-in-out, infinite. Set `transform-origin` to the left edge for left-aligned figures.
- **Winning-ball entrance:** when the band is revealed, each ball plays `scale(0) rotate(-120deg), opacity 0 → scale(1.15) at 70% → scale(1)` over 700ms ease-out, delayed 300ms + i×180ms.
- **Winning-ball ring:** an infinite box-shadow ripple, `0 0 0 0 rgba(0,159,255,.6) → 0 0 0 16px rgba(0,159,255,0)`, 1.6s ease-out, delay 1.5s + (i%4)×400ms.
- **Count-up:** the jackpot (on load) and both totals (when revealed) count from 0 to their value over 1.6s with ease-out-cubic, formatted `£#,###` (en-GB).
- **Countdown:** updates every second to `drawAt`. At zero show "Draw in progress" and hide the boxes.
- **Hover:** nav and secondary links go to `#3068a7`; primary buttons go to `#3068a7` background; menu items get a `#009fff` background; the profile link goes to `opacity:.7`.

## Responsive
- Breakpoints used: 560px (Menu label hidden), 700px (past-draws table vs cards), 720px (current-draw grid 10 vs 5), 900px (landing jackpot alignment). Elsewhere, fluid `clamp()` values and `auto-fit` grids handle layout.
- Check every page at 375px, 768px, 1280px and 1920px. There must be no horizontal scroll at any width, except inside the past-draws table container.
- Tap targets are at least 44px (balls are ≥48px on mobile).

## State
- Landing (client-side): `picks: number[]` (max 4), `draws: 1|4|12`, `menuOpen`, the countdown clock, and the count-up values.
- Server data: `getOpenDraw` (number, `drawAt`, `entriesCloseAt`), `getDrawStats` (`jackpotEstimatePence`, `entriesCount`), `listSettledDraws` (latest row and past list), plus the **new** lifetime totals query.
- No open draw: the landing hero shows "Next draw coming soon" instead of the jackpot and countdown, and Easy entry is hidden.

## Design tokens
| Token | Value | Use |
|---|---|---|
| navy | `#094582` | primary, nav text, panels, buttons |
| sky | `#009fff` | accents, jagged lines, eyebrows, menu hover |
| mid | `#3068a7` | hover, eyebrows on ice, header layer |
| midnight | `#00091c` | icon colour on sky tiles |
| ice | `#f2f8fe` | headers, light panels |
| ice-2 | `#e1e8f9` | badge background |
| ice-line | `#b7c7f1` | notice border |
| steel-line | `#c9d7e4` | borders, unselected balls |
| pitch | `#8fa6c1` | disabled button |
| on-navy text | `#d3e4f5`, labels `#9cc9f0`, `#e6f0fa` | |
| grey-150 | `#efefef` | row and line dividers |
| grey-500 | `#6c757d` | labels, hints |
| grey-600 | `#666666` | body secondary |
| grey-800 | `#333333` | body |
| error | `#b3261e` on `#fdecea`, border `#f3c1bd` | |

Spacing: the DS scale is 5 / 15 / 25 / 35 / 45. The common gaps in the designs are 8 / 10 / 12 / 14 / 16 / 18 / 22 / 24 / 36 / 48 / 56 / 64px, with section padding 56–120px (clamped).
Type scale: 11 / 12 / 13 / 14 / 15 / 16 / 17 / 20 / 22 / 24 / 26 / 28 / 30 / 36 / 40 / 44 / 52–56 / 64 / 100 / 140px.
Radius: 0 everywhere; 4px on inputs; 50% on balls and avatar.

## Assets
- `designs/assets/qos-crest.png`: club crest (95×95, transparent). Put it in the API's static assets.
- `designs/assets/landing-hero.webp`: landing hero (match/crowd photo). `designs/assets/community-trust.webp`: Community Trust photo. Both are supplied by the club. Serve them as optimised WebP with JPEG fallback and descriptive `alt` text.
- Font Awesome 4.7 (CDN) and Google Fonts (above). The `_ds/` folder is the Queen of the South FC design-system tokens the prototypes load. Use it for reference only.

## Data shown in the prototypes is sample data
Draw 143 / £1,860 estimate, last draw 142 (3 · 9 · 14 · 18, £1,240, 2 winners), totals £48,200 / £38,560, and the past-draws rows are all placeholders. Use the real database values.

## Screenshots
`screenshots/` is captured at a ~907px-wide preview, so each image shows the viewport, not the full page.
- `01a`–`01h`: the landing page, top to bottom (hero, last draw, easy entry, how to play, totals, split, community, footer)
- `02-sign-up`, `03-log-in`, `04-forgotten-password`, `05-reset-password`, `06-past-draws`, `07-current-draw`, `08-payment`: the top of each inner page

## Files
- `designs/Landing Page v2.dc.html`: landing page (final). Photos load from `designs/.image-slots.state.json`.
- `designs/Public Pages v2.dc.html`: all 7 inner pages (final; use the top review bar to switch pages)
- `designs/reference/Current - Sign up.dc.html`: the current UI, for comparison
- Source to change: `apps/api/src/views.ts` (STYLE, `layout()`, every public page function), `apps/api/src/index.ts` (a new `/` route), `apps/api/src/db.ts` (lifetime totals query)
