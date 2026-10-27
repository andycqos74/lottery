#!/usr/bin/env tsx
/**
 * Go-live check for the FAQ page copy (design_handoff_public_pages, page 9):
 * fails while any answer still holds a [placeholder] the club has to supply.
 *
 * Not part of `pnpm test`: the copy is final apart from those placeholders,
 * so this would fail every CI run until the club's answers arrive. Run it
 * before go-live — `pnpm check:faq-copy` — and fill in each one it lists in
 * apps/api/src/faq.ts.
 */
import { faqPlaceholders } from '../apps/api/src/faq.js';

const left = faqPlaceholders();
if (left.length === 0) {
  console.log('FAQ copy: no placeholders left.');
} else {
  console.error(`FAQ copy: ${left.length} placeholder(s) still to replace in apps/api/src/faq.ts:`);
  for (const { question, placeholder } of left) console.error(`  ${question}  →  ${placeholder}`);
  process.exitCode = 1;
}
