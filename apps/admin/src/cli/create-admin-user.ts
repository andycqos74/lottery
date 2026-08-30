#!/usr/bin/env tsx
/**
 * Create the first (or another) admin account.
 *
 * T-9.3: individual named accounts, mandatory MFA, no shared logins — so
 * there is deliberately no self-service signup in the admin console itself.
 * This is how an account comes to exist: run once per person, by someone who
 * already has shell access to the deploy host.
 *
 *   ADMIN_EMAIL=treasurer@qosfc.example ADMIN_NAME="Jo Treasurer" pnpm create:admin-user
 *
 * Prints the generated password and the TOTP enrollment details ONCE. Nothing
 * is recoverable afterwards — the password is hashed, and the TOTP secret is
 * encrypted at rest — so hand them to the person over a channel you trust,
 * then let it scroll away.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hash as argon2Hash } from '@node-rs/argon2';
import { appDbConnectionFromEnv, createPool } from '@qosfc/db';
import { encryptSecret } from '../secret-box.js';
import { generateTotpSecret, totpUri } from '../totp.js';

const email = (process.env['ADMIN_EMAIL'] ?? '').trim().toLowerCase();
const displayName = (process.env['ADMIN_NAME'] ?? '').trim();
const mfaKeyFile = process.env['ADMIN_MFA_KEY_FILE'] ?? 'deploy/secrets/admin_mfa_key';

if (!email || !displayName) {
  console.error('Usage: ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" pnpm create:admin-user');
  process.exit(1);
}

const mfaKey = Buffer.from(readFileSync(mfaKeyFile, 'utf8').trim(), 'base64');

const pool = createPool({ ...appDbConnectionFromEnv(), applicationName: 'qosfc-create-admin-user', max: 1 });

try {
  const existing = await pool.query('SELECT id FROM app_user WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    console.error(`app_user with email "${email}" already exists. This script only creates new accounts.`);
    process.exit(1);
  }

  const password = randomBytes(24).toString('base64url');
  const passwordHash = await argon2Hash(password);

  const totpSecret = generateTotpSecret();
  const totpSecretEnc = encryptSecret(totpSecret, mfaKey);

  // GAP-03: the permission matrix is undefined, so 'staff' carries no
  // permissions of its own — access is whatever the admin console implements
  // for any authenticated account, not yet role-differentiated.
  await pool.query(
    `INSERT INTO app_role (name, description) VALUES ('staff', 'Admin console access — GAP-03 permission matrix pending')
     ON CONFLICT (name) DO NOTHING`,
  );

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO app_user (email, display_name, password_hash, totp_secret_enc, mfa_enrolled)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [email, displayName, passwordHash, totpSecretEnc],
  );
  const userId = inserted.rows[0]!.id;

  await pool.query(`INSERT INTO app_user_role (user_id, role) VALUES ($1, 'staff')`, [userId]);

  console.log(`\nAdmin account created for ${displayName} <${email}>.\n`);
  console.log(`Password (shown once): ${password}`);
  console.log(`\nMFA enrollment — add this to an authenticator app (1Password, Authy, Google Authenticator):`);
  console.log(`  Manual entry key: ${totpSecret}`);
  console.log(`  otpauth:// URI:   ${totpUri(totpSecret, email)}`);
  console.log(`\nNeither value is recoverable after this terminal scrolls away — the password is hashed`);
  console.log(`and the TOTP secret is encrypted at rest. Re-run this script to create a replacement account`);
  console.log(`if either is lost; there is no reset flow yet.`);
} finally {
  await pool.end();
}
