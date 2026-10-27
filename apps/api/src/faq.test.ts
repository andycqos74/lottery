import { describe, expect, it } from 'vitest';
import { FAQ, faqPlaceholders, type FaqSection } from './faq.js';
import { escapeHtml, faqPage, landingPage, pastDrawsPage } from './views.js';

describe('FAQ copy (design_handoff_public_pages, page 9)', () => {
  it("has the design's sections, in order, with every question", () => {
    expect(FAQ.map((s) => [s.title, s.items.length])).toEqual([
      ['About QOS Lotto', 10],
      ['Entering', 5],
      ['If you already pay by standing order', 10],
      ['If you pay through a collecting agent', 1],
      ['Winning', 4],
      ['Your account and support', 6],
    ]);
  });

  it('lists the [placeholders] still to be replaced, and none once they are', () => {
    expect(faqPlaceholders()).toContainEqual({ question: 'What is QOS Lotto?', placeholder: '[first draw date]' });
    const done: FaqSection[] = [{ title: 'T', items: [['Q?', 'Every Friday.']] }];
    expect(faqPlaceholders(done)).toEqual([]);
    expect(faqPlaceholders([{ title: 'T', items: [['Q?', 'Call [phone']] }])).toEqual([{ question: 'Q?', placeholder: '[phone' }]);
  });
});

describe('the FAQ page', () => {
  const html = faqPage({});

  it('renders every question and answer, escaped', () => {
    for (const s of FAQ) {
      for (const [q, a] of s.items) {
        expect(html).toContain(escapeHtml(q));
        expect(html).toContain(escapeHtml(a));
      }
    }
    const page = faqPage({ sections: [{ title: 'A & B', items: [['<b>?', 'x < y']] }] });
    expect(page).toContain('A &amp; B');
    expect(page).toContain('&lt;b&gt;?');
    expect(page).toContain('x &lt; y');
  });

  it('links each section, and each question controls its own answer', () => {
    FAQ.forEach((_, i) => {
      expect(html).toContain(`href="#faq-${i}"`);
      expect(html).toContain(`id="faq-${i}"`);
    });
    const controls = [...html.matchAll(/class="faq-q" aria-expanded="true" aria-controls="([^"]+)"/g)].map((m) => m[1]!);
    expect(controls).toHaveLength(FAQ.reduce((n, s) => n + s.items.length, 0));
    for (const id of controls) expect(html).toContain(`id="${id}"`);
  });

  it('sends every answer open, for readers without scripts', () => {
    expect(html).not.toMatch(/class="faq-q" aria-expanded="false"/);
    expect(html).toMatch(/class="faq-item is-open"/);
    expect(html).toContain('<button type="button" class="faq-toggle-all" hidden>');
  });

  it("uses the design's header copy", () => {
    expect(html).toContain('<span class="eyebrow">Help</span>');
    expect(html).toContain('<h1>Questions and answers</h1>');
  });

  it('is linked from the menu (logged in or out) and the footer, on the landing page and inner pages', () => {
    const member = { forename: 'Ken', csrf: 'x' };
    const landing = (m?: typeof member) =>
      landingPage({ member: m, totals: { prizePaidPence: 0n }, split: { prizeBp: 5000, goodCauseBp: 4000, adminBp: 1000 } });
    const pages = {
      'landing, logged out': landing(),
      'landing, logged in': landing(member),
      'inner, logged out': pastDrawsPage({ draws: [] }),
      'inner, logged in': pastDrawsPage({ member, draws: [] }),
    };
    for (const [name, html] of Object.entries(pages)) {
      const menu = html.slice(html.indexOf('id="site-menu"'), html.indexOf('</nav>'));
      const footer = html.slice(html.indexOf('<footer'));
      expect({ name, menu: menu.includes('href="/faq"'), footer: footer.includes('href="/faq"') }).toEqual({ name, menu: true, footer: true });
    }
  });
});
