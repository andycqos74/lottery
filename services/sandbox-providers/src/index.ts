#!/usr/bin/env node
/**
 * Dummy external systems (build plan §5).
 *
 * ⚠ NEVER deployed to production.
 *
 * A real HTTP service rather than in-process fakes, deliberately: fakes never
 * exercise webhook delivery, connection failures, or three-day settlement, so
 * the first live integration is where those bugs surface. This one models the
 * awkward parts on purpose — async settlement, out-of-order mandate messages,
 * duplicate webhooks, declines, and the OCR quirks in T-5.7 — so the unhappy
 * paths are exercised by default rather than discovered in production.
 */
import { createHmac, randomUUID } from 'node:crypto';
import Fastify from 'fastify';

const port = Number(process.env['PORT'] ?? 9090);
const declineRate = Number(process.env['SANDBOX_DECLINE_RATE'] ?? 0.1);
const duplicateWebhookRate = Number(process.env['SANDBOX_DUPLICATE_WEBHOOK_RATE'] ?? 0.05);
const settlementDays = Number(process.env['SANDBOX_BACS_SETTLEMENT_DAYS'] ?? 3);
const timeScale = Number(process.env['SANDBOX_TIME_SCALE'] ?? 1);
const webhookTarget = process.env['WEBHOOK_TARGET_URL'];
const signingSecret = process.env['SANDBOX_WEBHOOK_SECRET'] ?? 'sandbox-development-secret';

const app = Fastify({ logger: true });

/** Idempotency, modelled as a real PSP does it: same key, same response. */
const idempotencyCache = new Map<string, unknown>();
function withIdempotency<T>(key: string | undefined, produce: () => T): T {
  if (!key) return produce();
  const cached = idempotencyCache.get(key);
  if (cached !== undefined) return cached as T;
  const result = produce();
  idempotencyCache.set(key, result);
  return result;
}

const sessions = new Map<string, { status: string; amountPence: string; providerRef: string }>();
const submissions = new Map<string, { cycleKey: string; readyAt: number; instructions: { memberRef: string; amountPence: string }[] }>();
const mandates = new Map<string, { memberRef: string; status: string }>();
const mandateEvents: unknown[] = [];

app.get('/healthz', async () => ({ ok: true, provider: 'sandbox' }));

// ── PSP (GAP-09) ─────────────────────────────────────────────────────────────
app.post<{ Body: { amountPence: string; reference: string; returnUrl: string } }>(
  '/psp/sessions',
  async (request) => {
    const key = request.headers['idempotency-key'] as string | undefined;
    return withIdempotency(key, () => {
      const sessionId = `sess_${randomUUID()}`;
      const declined = Math.random() < declineRate;
      sessions.set(sessionId, {
        status: declined ? 'failed' : 'succeeded',
        amountPence: request.body.amountPence,
        providerRef: `pay_${randomUUID()}`,
      });
      // Asynchronous callback, exactly as a real PSP does — and sometimes twice,
      // because a webhook that arrives twice is normal and must be idempotent.
      void deliverWebhook({ sessionId, outcome: sessions.get(sessionId) });
      return {
        sessionId,
        redirectUrl: `${request.body.returnUrl}?session=${sessionId}`,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      };
    });
  },
);

app.get<{ Params: { id: string } }>('/psp/sessions/:id', async (request, reply) => {
  const session = sessions.get(request.params.id);
  if (!session) return reply.code(404).send({ reasonCode: 'not_found', reason: 'no such session' });
  return session.status === 'succeeded'
    ? { status: 'succeeded', providerRef: session.providerRef, amountPence: session.amountPence }
    : { status: 'failed', reasonCode: 'card_declined', reason: 'The card was declined.' };
});

app.post('/psp/refunds', async (request) => {
  const key = request.headers['idempotency-key'] as string | undefined;
  return withIdempotency(key, () => ({ refundRef: `ref_${randomUUID()}` }));
});

// ── Bacs bureau (GAP-10) ─────────────────────────────────────────────────────
app.post<{ Body: { memberRef: string; returnUrl: string } }>('/bacs/mandates', async (request) => {
  const key = request.headers['idempotency-key'] as string | undefined;
  return withIdempotency(key, () => {
    const mandateRef = `MD${randomUUID().slice(0, 12).toUpperCase()}`;
    mandates.set(mandateRef, { memberRef: request.body.memberRef, status: 'pending' });
    // AUDDIS-shaped: the mandate becomes active LATER, out of band.
    setTimeout(() => {
      mandates.set(mandateRef, { memberRef: request.body.memberRef, status: 'active' });
      mandateEvents.push({
        eventId: randomUUID(),
        mandateRef,
        memberRef: request.body.memberRef,
        kind: 'mandate_active',
        occurredAt: new Date().toISOString(),
        detail: 'sandbox mandate activated',
      });
    }, 2000 / timeScale).unref?.();
    return { mandateRef, status: 'pending', setupRedirectUrl: `${request.body.returnUrl}?mandate=${mandateRef}` };
  });
});

app.get<{ Params: { ref: string } }>('/bacs/mandates/:ref', async (request, reply) => {
  const mandate = mandates.get(request.params.ref);
  if (!mandate) return reply.code(404).send({ reasonCode: 'not_found', reason: 'no such mandate' });
  return { mandateRef: request.params.ref, status: mandate.status };
});

app.post<{ Body: { cycleKey: string; instructions: { memberRef: string; amountPence: string }[] } }>(
  '/bacs/submissions',
  async (request) => {
    const key = request.headers['idempotency-key'] as string | undefined;
    return withIdempotency(key, () => {
      const submissionId = `sub_${randomUUID()}`;
      // Three working days, compressible for local development. The workflow's
      // durable timer is unaffected — only the sandbox's clock moves.
      const readyAt = Date.now() + (settlementDays * 86_400_000) / timeScale;
      submissions.set(submissionId, { cycleKey: request.body.cycleKey, readyAt, instructions: request.body.instructions });
      return {
        submissionId,
        acceptedCount: request.body.instructions.length,
        rejectedCount: 0,
        rejections: [],
        resultsExpectedAt: new Date(readyAt).toISOString(),
      };
    });
  },
);

app.get<{ Params: { id: string } }>('/bacs/submissions/:id/results', async (request, reply) => {
  const submission = submissions.get(request.params.id);
  if (!submission) return reply.code(404).send({ reasonCode: 'not_found', reason: 'no such submission' });
  if (Date.now() < submission.readyAt) return { ready: false };
  return {
    ready: true,
    results: submission.instructions.map((i) =>
      Math.random() < declineRate
        ? { memberRef: i.memberRef, status: 'failed', reasonCode: 'ARUDD-0', reason: 'Refer to payer' }
        : { memberRef: i.memberRef, status: 'collected', amountPence: i.amountPence },
    ),
  };
});

app.get('/bacs/mandate-events', async () => mandateEvents);

// ── Bank feed (GAP-33) ───────────────────────────────────────────────────────
// Serves all three candidate shapes from the same fixtures, so the matching
// engine can be built and proven before the decision lands.
app.get('/bank/statements', async (request) => {
  const source = (request.query as { source?: string }).source ?? 'ocr_pdf';
  return [
    {
      statementNumber: 601,
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
      openingBalancePence: '1250000',
      closingBalancePence: '1310000',
      source,
      sourceRef: 'object://statements/601.pdf',
    },
  ];
});

app.get<{ Params: { n: string } }>('/bank/statements/:n/credits', async (request) => {
  const source = (request.query as { source?: string }).source ?? 'ocr_pdf';
  const ocr = source === 'ocr_pdf';
  return {
    credits: [
      // A clean standing order credit.
      { externalId: 'c1', valueDate: '2026-07-03', description: 'BANK GIRO CREDIT 1002',
        typeRaw: 'Standing Order', amountPence: '868', isCredit: true,
        extractedReference: '1002', extractedName: 'A MEMBER', confidence: ocr ? 0.97 : undefined },
      // T-5.7: the OCR dropped-decimal failure mode — 434 should read £4.34.
      { externalId: 'c2', valueDate: '2026-07-05', description: 'STANDING ORDER 1145',
        typeRaw: 'Standing Order', amountPence: ocr ? '43400' : '434', isCredit: true,
        extractedReference: '1145', confidence: ocr ? 0.42 : undefined },
      // Paired reference: one credit covering two memberships.
      { externalId: 'c3', valueDate: '2026-07-08', description: 'TRANSFER 2802/2085',
        typeRaw: 'Transfer', amountPence: '868', isCredit: true,
        extractedReference: '2802/2085', confidence: ocr ? 0.88 : undefined },
      // Agent bulk lodgement: never member-matched, reconciled as a control total.
      { externalId: 'c4', valueDate: '2026-07-10', description: 'BRANCH CASH LODGEMENT',
        typeRaw: 'Branch', amountPence: '24000', isCredit: true, confidence: ocr ? 0.91 : undefined },
    ],
  };
});

// ── Notifications (GAP-30) ───────────────────────────────────────────────────
app.post<{ Body: { channel: string; memberRef: string } }>('/notify/send', async (request) => {
  const key = request.headers['idempotency-key'] as string | undefined;
  return withIdempotency(key, () =>
    Math.random() < declineRate
      ? { status: 'rejected', reasonCode: 'invalid_address', reason: 'No deliverable address on file.' }
      : { status: 'accepted', providerRef: `msg_${randomUUID()}` },
  );
});

app.get('/notify/events', async () => []);

app.post('/print/batches', async (request) => {
  const key = request.headers['idempotency-key'] as string | undefined;
  const body = request.body as { itemCount: number };
  return withIdempotency(key, () => ({ batchRef: `batch_${randomUUID()}`, acceptedCount: body.itemCount }));
});

/**
 * Signed, and sometimes delivered twice.
 *
 * Both details matter: a webhook receiver that does not verify the signature
 * trusts a stranger, and one that is not idempotent double-credits a member the
 * first time a real PSP retries.
 */
async function deliverWebhook(payload: unknown): Promise<void> {
  if (!webhookTarget) return;
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', signingSecret).update(body).digest('hex');
  const send = () =>
    fetch(webhookTarget, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sandbox-signature': signature },
      body,
    }).catch(() => undefined);

  await send();
  if (Math.random() < duplicateWebhookRate) await send();
}

await app.listen({ port, host: '0.0.0.0' });
