#!/usr/bin/env tsx
/**
 * The Phase 1 gate.
 *
 * Nothing else in the build starts until this passes. It checks the things that
 * are cheap to verify now and expensive to discover late — above all T-10.8,
 * whether Workflow Update actually works end to end on the pinned server
 * version, because FR-3.3 (a member gets an immediate accept or reject on a
 * selection change) is built on it.
 *
 *   pnpm verify:stack
 */
import { randomBytes } from 'node:crypto';
import { createPool } from '@qosfc/db';
import {
  EncryptionCodec,
  InMemoryKeyProvider,
  SEARCH_ATTRIBUTES,
  connectionConfigFromEnv,
  createClient,
  findPiiViolations,
} from '@qosfc/temporal-common';
import { METADATA_ENCODING_KEY } from '@temporalio/common';

interface Check {
  readonly name: string;
  readonly detail: string;
  readonly run: () => Promise<string>;
}

const checks: Check[] = [];
const check = (name: string, detail: string, run: () => Promise<string>) => checks.push({ name, detail, run });

// ── 1. The system of record ──────────────────────────────────────────────────
check('postgres-app reachable', 'T-1.1: the ledger is the system of record', async () => {
  const pool = createPool({
    connectionString: required('APP_DB_URL'),
    applicationName: 'verify-stack',
    max: 1,
  });
  try {
    const { rows } = await pool.query<{ v: string }>('SELECT version() AS v');
    const { rows: migrations } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM schema_migration',
    );
    return `${rows[0]!.v.split(',')[0]}, ${migrations[0]!.n} migration(s) applied`;
  } finally {
    await pool.end();
  }
});

check('money survives the round trip as bigint', 'NFR-2: no floating-point money, ever', async () => {
  const pool = createPool({ connectionString: required('APP_DB_URL'), applicationName: 'verify-stack', max: 1 });
  try {
    const { rows } = await pool.query<{ big: unknown }>(`SELECT 9223372036854775807::bigint AS big`);
    if (typeof rows[0]!.big !== 'bigint') {
      throw new Error(
        `int8 came back as ${typeof rows[0]!.big}, not bigint. configurePgTypes() is not taking effect, ` +
          `and money would silently become floating point.`,
      );
    }
    return 'int8 parses to BigInt';
  } finally {
    await pool.end();
  }
});

check('append-only guarantee holds', 'T-9.4: the app role cannot rewrite the books', async () => {
  const pool = createPool({ connectionString: required('APP_DB_URL'), applicationName: 'verify-stack', max: 1 });
  try {
    const { rows } = await pool.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'lottery_app' AND table_name IN ('ledger_entry','audit_log')
          AND privilege_type IN ('UPDATE','DELETE','TRUNCATE')`,
    );
    if (rows.length > 0) {
      throw new Error(
        `lottery_app can still ${rows.map((r) => `${r.privilege_type} ${r.table_name}`).join(', ')}. ` +
          `Migration 0007 has not been applied, or a later grant undid it.`,
      );
    }
    return 'no UPDATE/DELETE/TRUNCATE grant on ledger_entry or audit_log';
  } finally {
    await pool.end();
  }
});

// ── 2. Payload protection (TG-11) ────────────────────────────────────────────
check('encryption codec round-trips', 'TG-11: history must be ciphertext at rest', async () => {
  const key = randomBytes(32);
  const codec = new EncryptionCodec(new InMemoryKeyProvider(new Map([['verify', key]]), 'verify'));
  const marker = `verify-${randomBytes(8).toString('hex')}`;
  const payload = {
    metadata: { [METADATA_ENCODING_KEY]: Buffer.from('json/plain', 'utf8') },
    data: Buffer.from(JSON.stringify({ marker }), 'utf8'),
  };
  const [encrypted] = await codec.encode([payload]);
  if (Buffer.from(encrypted!.data!).toString('binary').includes(marker)) {
    throw new Error('Plaintext survived encoding — the codec is not encrypting.');
  }
  const [decoded] = await codec.decode([encrypted!]);
  if (!Buffer.from(decoded!.data!).toString('utf8').includes(marker)) {
    throw new Error('Round trip lost the payload.');
  }
  return 'AES-256-GCM encrypt/decrypt verified, plaintext absent from ciphertext';
});

check('PII guard detects personal data', 'T-1.3: identifier-only payloads', async () => {
  const found = findPiiViolations({ memberId: 'ok', member: { surname: 'Pattie', postcode: 'DG1 1AA' } });
  if (found.length < 2) throw new Error(`Guard found ${found.length} violations in a payload with two.`);
  if (findPiiViolations({ memberId: 'a3f1', drawId: 'b7c2', amountPence: '200' }).length !== 0) {
    throw new Error('Guard produced a false positive on an identifier-only payload.');
  }
  return `detects field-name and value-pattern violations, no false positives on identifiers`;
});

// ── 3. Temporal ──────────────────────────────────────────────────────────────
check('temporal frontend reachable', 'the orchestration layer is up', async () => {
  const client = await createClient(connectionConfigFromEnv());
  try {
    const { namespace } = connectionConfigFromEnv();
    await client.connection.workflowService.describeNamespace({ namespace });
    return `namespace "${namespace}" exists`;
  } finally {
    client.connection.close();
  }
});

check('search attributes registered', 'T-10.7: unregistered attributes fail at RUNTIME', async () => {
  const config = connectionConfigFromEnv();
  const client = await createClient(config);
  try {
    const response = await client.connection.operatorService.listSearchAttributes({
      namespace: config.namespace,
    });
    const present = new Set(Object.keys(response.customAttributes ?? {}));
    const missing = Object.keys(SEARCH_ATTRIBUTES).filter((name) => !present.has(name));
    if (missing.length > 0) {
      throw new Error(
        `Missing: ${missing.join(', ')}. Run deploy/bootstrap/bootstrap-temporal.sh. ` +
          `Workflow code that sets an unregistered attribute fails at runtime, mid-draw.`,
      );
    }
    return `all ${Object.keys(SEARCH_ATTRIBUTES).length} custom attributes present`;
  } finally {
    client.connection.close();
  }
});

/**
 * T-10.8 — the check this script exists for.
 *
 * Workflow Update must both ACCEPT a valid change and REJECT an invalid one
 * synchronously. If Updates are not enabled on the pinned server version, this
 * fails here, cheaply — rather than after the member-facing selection UI has
 * been built on top of them.
 */
check('workflow update enabled', 'T-10.8: FR-3.3 depends on synchronous accept/reject', async () => {
  const config = connectionConfigFromEnv();
  const client = await createClient(config);
  try {
    const handle = await client.workflow.start('StackVerificationWorkflow', {
      taskQueue: 'draw',
      workflowId: `verify-stack-${Date.now()}`,
      args: [],
      workflowExecutionTimeout: '2 minutes',
    });
    try {
      const accepted = await handle.executeUpdate('setSelection', { args: [[3, 9, 14, 20]] });
      let rejected = false;
      try {
        await handle.executeUpdate('setSelection', { args: [[1, 1, 2, 3]] });
      } catch {
        rejected = true;   // the validator rejected it, which is the point
      }
      if (!rejected) throw new Error('An invalid selection was ACCEPTED. The update validator is not running.');
      return `update accepted ${JSON.stringify(accepted)} and rejected a duplicate-number selection`;
    } finally {
      await handle.terminate('stack verification complete').catch(() => {});
    }
  } finally {
    client.connection.close();
  }
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

// ── Run ──────────────────────────────────────────────────────────────────────
let failures = 0;
console.log('\nQOSFC lottery — Phase 1 stack verification\n');
for (const { name, detail, run } of checks) {
  try {
    const result = await run();
    console.log(`  ✓ ${name}\n      ${result}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${name}  (${detail})`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(
  failures === 0
    ? `\nAll ${checks.length} checks passed. The Phase 1 gate is open.\n`
    : `\n${failures} of ${checks.length} checks FAILED. Do not build on this stack until they pass.\n`,
);
process.exit(failures === 0 ? 0 : 1);
