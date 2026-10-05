/*
 * The Doonhamers Draw — public pages behaviour.
 *
 * One file, not inline <script> blocks: the site runs under a strict CSP
 * (script-src 'self'). Each feature looks for its own markup and does nothing
 * when the page doesn't have it; page-specific values arrive as data-*
 * attributes. Every form still submits and validates server-side without this.
 */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function gbp(pence) { return '£' + Math.round(pence / 100).toLocaleString('en-GB'); }

  // ── Menu ──────────────────────────────────────────────────────────────────
  var menuBtn = $('.menu-btn');
  var menu = $('#site-menu');
  if (menuBtn && menu) {
    var glyph = $('.menu-glyph', menuBtn);
    var setOpen = function (open) {
      menu.hidden = !open;
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (glyph) glyph.textContent = open ? '×' : '☰';
    };
    menuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(menu.hidden);
    });
    document.addEventListener('click', function (e) {
      if (!menu.hidden && !menu.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !menu.hidden) { setOpen(false); menuBtn.focus(); }
    });
  }

  // ── Confirm before a destructive form submits (was an inline onsubmit) ──
  $$('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.dataset.confirm)) e.preventDefault();
    });
  });

  // ── Count-up (landing jackpot on load, totals when revealed) ──────────────
  function countUp(el) {
    if (el.dataset.counted) return;
    el.dataset.counted = '1';
    var target = Number(el.dataset.countTo);
    var finalText = el.textContent;
    if (reduceMotion || !isFinite(target) || target <= 0) return;
    var t0 = performance.now();
    var step = function (t) {
      var k = Math.min(1, (t - t0) / 1600);
      var eased = 1 - Math.pow(1 - k, 3);
      // End on the server's own text, so a figure with pence is never misstated.
      el.textContent = k < 1 ? gbp(target * eased) : finalText;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ── Scroll reveal (landing only; inner pages animate in CSS) ──────────────
  if (document.body.classList.contains('page-landing')) {
    var els = $$('[data-reveal]');
    var show = function (el) {
      el.classList.remove('is-hidden');
      el.classList.add('is-shown');
      $$('[data-count-to]', el).concat(el.matches('[data-count-to]') ? [el] : []).forEach(countUp);
    };
    if (reduceMotion || !('IntersectionObserver' in window)) {
      els.forEach(show);
    } else {
      var vh = window.innerHeight || document.documentElement.clientHeight;
      // Only pre-hide what starts below the fold: anything visible on load shows at once.
      els.forEach(function (el) {
        if (el.getBoundingClientRect().top >= vh) el.classList.add('is-hidden');
        else show(el);
      });
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) show(entry.target);
          // Re-hide once it has left below the viewport, so the effect replays.
          else if (entry.boundingClientRect.top > 0) {
            entry.target.classList.add('is-hidden');
            entry.target.classList.remove('is-shown');
          }
        });
      }, { threshold: 0.15 });
      els.forEach(function (el) { io.observe(el); });
    }
  }

  // ── Countdown to the draw ─────────────────────────────────────────────────
  var countdown = $('[data-countdown]');
  if (countdown) {
    var drawAt = Date.parse(countdown.dataset.countdown);
    var boxes = { d: $('[data-unit="d"]', countdown), h: $('[data-unit="h"]', countdown), m: $('[data-unit="m"]', countdown), s: $('[data-unit="s"]', countdown) };
    var live = $('.countdown-live', countdown.parentNode);
    var pad = function (v) { return String(v).padStart(2, '0'); };
    var tick = function () {
      var ms = Math.max(0, drawAt - Date.now());
      if (ms === 0) {
        countdown.hidden = true;
        if (live) live.hidden = false;
        return false;
      }
      boxes.d.textContent = pad(Math.floor(ms / 864e5));
      boxes.h.textContent = pad(Math.floor(ms / 36e5) % 24);
      boxes.m.textContent = pad(Math.floor(ms / 6e4) % 60);
      boxes.s.textContent = pad(Math.floor(ms / 1e3) % 60);
      return true;
    };
    if (isFinite(drawAt) && tick()) {
      var timer = setInterval(function () { if (!tick()) clearInterval(timer); }, 1000);
    }
  }

  // ── Split bar: widths from the configured split ───────────────────────────
  $$('.split-bar[data-split]').forEach(function (bar) {
    var parts = bar.dataset.split.split(',').map(Number);
    $$('i', bar).forEach(function (seg, i) { if (isFinite(parts[i])) seg.style.flexGrow = String(parts[i]); });
  });

  // ── Number pickers: at most four per line, Lucky Dip / Pick for me ────────
  function luckyDip(boxes) {
    boxes.forEach(function (b) { b.checked = false; });
    var pool = boxes.slice();
    for (var n = 0; n < 4 && pool.length; n++) pool.splice(Math.floor(Math.random() * pool.length), 1)[0].checked = true;
  }
  function limitToFour(root, boxes, onChange) {
    boxes.forEach(function (b) {
      b.addEventListener('change', function () {
        if ($$('input[type=checkbox]:checked', root).length > 4) b.checked = false;
        onChange();
      });
    });
  }

  // Landing: one line, live submit label.
  var easy = $('#easy-form');
  if (easy) {
    var easyBoxes = $$('input[name=line1]', easy);
    var easyCount = $('.easy-count', easy);
    var easySubmit = $('#easy-submit', easy);
    var easyLabel = $('.label', easySubmit);
    var refreshEasy = function () {
      var picked = $$('input[name=line1]:checked', easy).length;
      var draws = Number(($('input[name=blocks]:checked', easy) || {}).value || 1);
      easyCount.textContent = picked + ' of 4 selected';
      var ready = picked === 4;
      easySubmit.classList.toggle('is-incomplete', !ready);
      easySubmit.setAttribute('aria-disabled', ready ? 'false' : 'true');
      easyLabel.textContent = ready
        ? 'Continue to payment · £' + (draws * 2).toFixed(2)
        : 'Pick ' + (4 - picked) + ' more number' + (4 - picked === 1 ? '' : 's');
    };
    limitToFour(easy, easyBoxes, refreshEasy);
    $$('input[name=blocks]', easy).forEach(function (r) { r.addEventListener('change', refreshEasy); });
    $('#easy-lucky', easy).addEventListener('click', function () { luckyDip(easyBoxes); refreshEasy(); });
    easy.addEventListener('submit', function (e) {
      if ($$('input[name=line1]:checked', easy).length !== 4) e.preventDefault();
    });
    refreshEasy();
  }

  // Current draw: several lines.
  var pickForm = $('#pick-form');
  if (pickForm) {
    var lines = $$('.pick-line', pickForm);
    var addLine = $('#add-line');
    var refreshAdd = function () { addLine.hidden = $$('.pick-line[hidden]', pickForm).length === 0; };
    lines.forEach(function (line) {
      var count = $('.pick-count', line);
      var boxes = $$('input[type=checkbox]', line);
      var update = function () { count.textContent = $$('input:checked', line).length + ' of 4 selected'; };
      limitToFour(line, boxes, update);
      $('.quick-pick', line).addEventListener('click', function () { luckyDip(boxes); update(); });
      var remove = $('.remove-line', line);
      if (remove) remove.addEventListener('click', function () {
        // A removed line sends nothing: its boxes are cleared, not just hidden.
        boxes.forEach(function (b) { b.checked = false; });
        line.hidden = true;
        update();
        refreshAdd();
      });
      update();
    });
    addLine.addEventListener('click', function () {
      var next = $('.pick-line[hidden]', pickForm);
      if (next) next.hidden = false;
      refreshAdd();
    });
    refreshAdd();
  }

  // ── Payment: card or Direct Debit (GitHub #8) ─────────────────────────────
  var payForm = $('#pay-form');
  if (payForm) {
    var hints = JSON.parse(payForm.dataset.hints);
    var summaries = JSON.parse(payForm.dataset.summaries);
    var lineCount = Number(payForm.dataset.lines);
    var submit = $('#pay-submit');
    var hint = $('#pay-hint');
    var showEl = function (id, on) { document.getElementById(id).hidden = !on; };
    var choose = function (method) {
      var isCard = method === 'card';
      showEl('pay-card', isCard); showEl('pay-dd', !isCard);
      showEl('summary-none', false); showEl('summary-card', isCard); showEl('summary-dd', !isCard);
      showEl('submit-card-label', isCard); showEl('submit-dd-label', !isCard);
      submit.hidden = false;
      // Only the visible section's fields are required, and the number of draws
      // only exists for card: a Direct Debit has no end.
      $$('#pay-card [data-required]').forEach(function (el) { el.required = isCard; });
      $$('#pay-dd [data-required]').forEach(function (el) { el.required = !isCard; });
      $$('input[name=blocks]').forEach(function (el) { el.disabled = !isCard; });
      payForm.action = isCard ? '/draw/enter' : '/direct-debit/setup';
      hint.textContent = hints[method];
    };
    $$('input[name=method]').forEach(function (r) {
      r.addEventListener('change', function () { choose(r.value); });
      if (r.checked) choose(r.value);
    });
    var summaryLine = $('#summary-line');
    var totals = $$('.blocks-total');
    $$('input[name=blocks]').forEach(function (r) {
      r.addEventListener('change', function () {
        var amount = '£' + (Number(r.value) * 2 * lineCount).toFixed(2);
        summaryLine.textContent = summaries[r.value];
        totals.forEach(function (el) { el.textContent = amount; });
      });
    });
  }
})();
