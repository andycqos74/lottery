#!/usr/bin/env node
/**
 * Member-facing API and public results.
 *
 * Reads come from PostgreSQL; writes go through Temporal clients — start,
 * signal, update, query (technical spec §1). The API never writes business state
 * directly, so every state change carries a workflow's durability, idempotency
 * and audit trail rather than depending on a request completing.
 */
import Fastify from 'fastify';
import { appDbConnectionFromEnv, createPool } from '@qosfc/db';

const port = Number(process.env['PORT'] ?? 8080);
const pool = createPool({
  ...appDbConnectionFromEnv(),
  applicationName: 'qosfc-api',
  max: 10,
});

const app = Fastify({
  logger: {
    // T-9.5 / NFR-6: personal data must not leak into operational infrastructure
    // that is outside the system's own retention and access controls. Logs are
    // exactly that, so the obvious carriers are redacted at the serialiser.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.body.email',
        'req.body.password',
        'req.body.surname',
        'req.body.postcode',
      ],
      censor: '[redacted]',
    },
  },
  // Trust the single reverse proxy in front of us, so rate limiting and logging
  // see the real client address rather than Caddy's.
  trustProxy: true,
  bodyLimit: 1024 * 1024,
});

app.get('/healthz', async () => ({ ok: true }));

app.get('/readyz', async (_request, reply) => {
  try {
    await pool.query('SELECT 1');
    return { ok: true };
  } catch {
    return reply.code(503).send({ ok: false, reason: 'database unavailable' });
  }
});

/**
 * Public results. No authentication and no personal data — FR-6 output only.
 * GAP-29 (whether winners' names are published, and what consent is captured)
 * is unresolved, so no name is exposed here under any circumstances.
 */
app.get('/results', async () => {
  const { rows } = await pool.query(
    `SELECT draw_number, draw_date, winning_numbers,
            jackpot_paid_pence::text  AS jackpot_paid_pence,
            rollover_out_pence::text  AS rollover_out_pence,
            winners_count
       FROM draw
      WHERE status = 'settled'
      ORDER BY draw_number DESC
      LIMIT 20`,
  );
  return { draws: rows };
});

await app.listen({ port, host: '0.0.0.0' });
