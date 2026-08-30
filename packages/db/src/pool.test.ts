import { describe, expect, it } from 'vitest';
import { appDbConnectionFromEnv } from './pool.js';

describe('appDbConnectionFromEnv', () => {
  it('defaults to the local-dev lottery_app role and secrets file when nothing is set', () => {
    expect(appDbConnectionFromEnv({})).toEqual({
      connectionString: 'postgres://lottery_app@127.0.0.1:5432/lottery_app',
      passwordFile: 'deploy/secrets/app_role_password',
    });
  });

  it('uses APP_DB_URL when set, without inventing a password file', () => {
    expect(appDbConnectionFromEnv({ APP_DB_URL: 'postgres://lottery_app@postgres-app:5432/lottery_app' })).toEqual({
      connectionString: 'postgres://lottery_app@postgres-app:5432/lottery_app',
      passwordFile: undefined,
    });
  });

  it('honours an explicit APP_DB_PASSWORD_FILE alongside a custom APP_DB_URL', () => {
    expect(
      appDbConnectionFromEnv({
        APP_DB_URL: 'postgres://lottery_app@postgres-app:5432/lottery_app',
        APP_DB_PASSWORD_FILE: '/run/secrets/app_role_password',
      }),
    ).toEqual({
      connectionString: 'postgres://lottery_app@postgres-app:5432/lottery_app',
      passwordFile: '/run/secrets/app_role_password',
    });
  });
});
