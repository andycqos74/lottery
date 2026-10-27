/**
 * The FAQ page copy (design_handoff_public_pages, page 9). Final wording,
 * used verbatim: edit the words here, not in the markup (faqPage() in
 * views.ts renders whatever this holds, in this order).
 *
 * Text in [square brackets] is copy the club still has to supply — draw day,
 * web address, phone numbers, registration number and so on. Every bracket
 * must be replaced before go-live: `pnpm check:faq-copy` lists what is left
 * and fails until none is.
 */

export interface FaqSection {
  readonly title: string;
  readonly items: readonly (readonly [question: string, answer: string])[];
}

export const FAQ: readonly FaqSection[] = [
  {
    title: 'About QOS Lotto',
    items: [
      [
        'What is QOS Lotto?',
        "It's Queen of the South's club lottery, now a weekly match-the-numbers draw. It replaces the old numbered raffle from [first draw date].",
      ],
      [
        'How does it work?',
        'Each ticket has 4 numbers from 1 to 20. Every [draw day] we draw 4 numbers. If your ticket matches all 4, you win the jackpot.',
      ],
      [
        'How much is a ticket?',
        '£2 per ticket, per draw.',
      ],
      [
        'How much can I win?',
        'The jackpot is never less than £500. If nobody wins, it rolls over to the next week and keeps growing. [It must be won once it reaches £20,000 — wording to follow.]',
      ],
      [
        'What are the odds of winning?',
        '1 in 4,845 for each ticket.',
      ],
      [
        'Are there smaller prizes for matching 2 or 3 numbers?',
        'No. The whole prize fund goes into the jackpot, so it grows faster.',
      ],
      [
        'What if more than one ticket matches?',
        'The jackpot is shared equally between the winning tickets.',
      ],
      [
        'How is the draw made?',
        '[Method, e.g. a certified random number generator or a ball machine, witnessed by two people.] Results are published every [draw day].',
      ],
      [
        'Where does the money go?',
        'For every £2 ticket, £1 goes to prizes, 80p goes to [what the money funds] and 20p covers running costs.',
      ],
      [
        'Who can play?',
        'Anyone aged 16 or over. [Any other limits, e.g. UK residents only, or exclusions for people who run the draw.]',
      ],
    ],
  },
  {
    title: 'Entering',
    items: [
      [
        'How do I enter?',
        'Online by debit card or Direct Debit at [web address], or [through one of our collecting agents / at the club shop].',
      ],
      [
        'Can I choose my own numbers?',
        "Yes, if you enter online or by Direct Debit. If you'd rather not choose, we can pick random numbers for you.",
      ],
      [
        'Can I keep the same numbers every week?',
        'Yes. On Direct Debit your numbers go into every draw automatically until you cancel.',
      ],
      [
        'Can I buy more than one ticket?',
        'Yes. Each ticket is £2 and can have different numbers.',
      ],
      [
        'When do entries close?',
        "[Cut-off time and day] before each draw. Entries after that go into the following week's draw.",
      ],
    ],
  },
  {
    title: 'If you already pay by standing order',
    items: [
      [
        'Do I need to do anything?',
        "No. Your standing order carries on as it is, and you'll keep playing in QOS Lotto.",
      ],
      [
        'What will I get for my payment?',
        "Every £2 you pay buys one ticket. We'll write and tell you exactly how many draws your payment covers.",
      ],
      [
        'I pay £4.34 a month. What does that get me now?',
        'A ticket in every other draw. That amount was set for the old £1-a-week draw, and tickets are now £2. To play every week, raise your standing order to £8.67 a month or switch to Direct Debit.',
      ],
      [
        'Which draws am I in?',
        "If you pay for a ticket every week, you're in every draw. If you pay for every other week, you're in the first draw and then every second week after that. Your letter gives your first draw date.",
      ],
      [
        'Why do standing order members get random numbers?',
        "Your bank sends standing order payments without any instructions attached, so we can't link a payment to numbers you've chosen. A computer picks your 4 numbers, and they stay the same every week you play.",
      ],
      [
        'Are random numbers less likely to win?',
        'No. Every combination has exactly the same 1 in 4,845 chance.',
      ],
      [
        'I want to choose my own numbers. What do I do?',
        "Switch to Direct Debit at [web address] or call [phone]. Wait until we've written to confirm your Direct Debit before you ask your bank to cancel your standing order, so you don't miss any draws.",
      ],
      [
        'What happens to my old raffle number?',
        'Your member number stays the same, so we can find your record. Your 4 lotto numbers replace your old raffle number for the draw.',
      ],
      [
        'I want to change how much I pay.',
        'Ask your bank to change your standing order, then let us know on [phone] or [email] so we can update your entries.',
      ],
      [
        "My payment doesn't divide exactly into £2 tickets.",
        'Any small amount left over [goes to (what the money funds) / is carried forward toward your next ticket].',
      ],
    ],
  },
  {
    title: 'If you pay through a collecting agent',
    items: [
      [
        'What happens to my entry?',
        'Your agent will be in touch before [first draw date] to explain how to enter the new draw. [Details to follow once the agent process is confirmed.]',
      ],
    ],
  },
  {
    title: 'Winning',
    items: [
      [
        "How will I know if I've won?",
        "Results are posted every [draw day] at [web address], on the club's social media and [in the club shop / matchday programme]. We'll also contact winners using the details we hold, so please keep your address and phone number up to date.",
      ],
      [
        'How do I claim?',
        'Call [phone] within [claim window] of the draw.',
      ],
      [
        'How are prizes paid?',
        '[By bank transfer / cheque] within [number] days of the claim being confirmed.',
      ],
      [
        'Will my name be published?',
        '[Only with your permission. We may publish the jackpot amount and the town you live in.]',
      ],
    ],
  },
  {
    title: 'Your account and support',
    items: [
      [
        'How do I stop playing?',
        "Standing order: cancel it with your bank and let us know. Direct Debit: contact us or cancel with your bank. Card: simply don't buy another ticket.",
      ],
      [
        "I've moved house or changed my details.",
        "Call [phone] or email [email] and we'll update your record.",
      ],
      [
        'Who runs QOS Lotto?',
        "Queen of the South FC Ltd Development Association. It's registered with Dumfries and Galloway Council under the Gambling Act 2005 [registration no.]. The promoter is [name], [address].",
      ],
      [
        'Where can I read the full rules?',
        'At [web address], or ask for a printed copy in the club shop.',
      ],
      [
        'What if playing stops being fun?',
        "Please play for fun and only spend what you can afford. For free, confidential support, call the National Gambling Helpline on 0808 8020 133 or visit begambleaware.org. To stop playing at any time, contact us and we'll close your entry.",
      ],
      [
        'Who do I contact with a question?',
        '[Name] on [phone] or [email].',
      ],
    ],
  },
];

/** Every [placeholder] still in the copy, with the question it is in. */
export function faqPlaceholders(sections: readonly FaqSection[] = FAQ): { question: string; placeholder: string }[] {
  return sections.flatMap((s) =>
    s.items.flatMap(([question, answer]) => (answer.match(/\[[^\]]*\]?/g) ?? []).map((placeholder) => ({ question, placeholder }))),
  );
}
